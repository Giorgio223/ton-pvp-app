// server.js (ESM) — TON PVP + Block Puzzle backend (FULL)
// Совместим с public/index.html из твоего проекта:
// - /api/session, /api/me
// - /api/deposit/create + /api/deposit/mine
// - /api/withdraw/request + /api/withdraw/mine (в withdraw_routes.js)
// - /api/spend (списать ставку/вступление) — возвращает game_run_id для game_start
// - /api/game/finish (начислить награду по score) — принимает {game_run_id, score}
// - /api/admin/credit (ручное начисление баланса)
// - /admin/admin_withdraw.html (выводы) + /admin/admin.html (начисление)
// ВАЖНО: .env грузим из папки проекта, даже если запуск из другой директории

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { db, initDb, ensureUser, getBalanceNano, addLedger } from './db.js';
import { registerWithdrawRoutes } from './withdraw_routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Грузим .env из папки проекта
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT || '8787');
const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || '').trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

const MIN_DEPOSIT_TON = Number(process.env.MIN_DEPOSIT_TON || '0.1');
const MIN_WITHDRAW_TON = Number(process.env.MIN_WITHDRAW_TON || '0.1');

// Ставка игры (Block Puzzle). В index.html по умолчанию 0.5
const GAME_ENTRY_TON = Number(process.env.GAME_ENTRY_TON || '0.5');

// === ТЕСТ-ПОРОГИ (как ты просил): 1000/2000/3000 ===
// Можешь потом поменять на 30000/50000/100000 и т.д.
const TETRIS_T1 = Number(process.env.TETRIS_T1 || '1000');
const TETRIS_T2 = Number(process.env.TETRIS_T2 || '2000');
const TETRIS_T3 = Number(process.env.TETRIS_T3 || '3000');

// Награды (мультипликатор к ставке). По умолчанию: 1x/2x/3x
// (то есть начисление: stake*multiplier)
const TETRIS_M1 = Number(process.env.TETRIS_M1 || '1');
const TETRIS_M2 = Number(process.env.TETRIS_M2 || '2');
const TETRIS_M3 = Number(process.env.TETRIS_M3 || '3');

if (!TREASURY_ADDRESS) {
  console.error('[server] TREASURY_ADDRESS missing in .env');
  process.exit(1);
}

initDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- Static ----
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---- Helpers ----
function tonToNanoBig(ton) {
  const s = String(ton);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Bad TON amount');
  const [a, b = ''] = s.split('.');
  const frac = (b + '000000000').slice(0, 9);
  return BigInt(a) * 1000000000n + BigInt(frac);
}

function nanoToTonStr(nano) {
  const n = BigInt(nano);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const whole = abs / 1000000000n;
  const frac = (abs % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return sign + whole.toString() + (frac ? '.' + frac : '');
}

function genId(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

function mustAdmin(req) {
  const token = (req.query.token || req.headers['x-admin-token'] || '').toString();
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    const e = new Error('Unauthorized');
    e.status = 401;
    throw e;
  }
}

function jsonError(res, e) {
  const status = e.status || 400;
  res.status(status).json({ ok: false, error: e.message || String(e) });
}

// ---- Sessions ----
app.post('/api/session', (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) throw new Error('address required');

    ensureUser(address);

    const token = genId('s_');
    const now = Date.now();

    db.prepare('INSERT INTO sessions(token,address,created_at,last_seen) VALUES (?,?,?,?)')
      .run(token, address, now, now);

    res.json({ ok: true, token, address });
  } catch (e) {
    jsonError(res, e);
  }
});

function getSession(req) {
  const token = (req.query.token || req.headers['x-session-token'] || (req.body && req.body.token) || '').toString();
  if (!token) return null;
  const s = db.prepare('SELECT token,address FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  db.prepare('UPDATE sessions SET last_seen=? WHERE token=?').run(Date.now(), token);
  return s;
}

// ---- Me / Balance ----
app.get('/api/me', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const balNano = getBalanceNano(s.address);
    res.json({
      ok: true,
      address: s.address,
      balanceNano: balNano.toString(),
      balanceTon: nanoToTonStr(balNano),
      balance_nano: balNano.toString(),
      balance_ton: nanoToTonStr(balNano),
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---- Deposits ----
app.post('/api/deposit/create', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const { amountTon, amount_ton } = req.body || {};
    const amountTonAny = amountTon ?? amount_ton;
    const amtTonNum = Number(amountTonAny);
    if (!Number.isFinite(amtTonNum) || amtTonNum <= 0) throw new Error('bad amount');
    if (amtTonNum < MIN_DEPOSIT_TON) throw new Error(`Минимальный депозит: ${MIN_DEPOSIT_TON} TON`);

    const baseNano = tonToNanoBig(amountTonAny);
    const dust = BigInt(1 + crypto.randomInt(9999)); // уникализация суммы
    const amountNano = baseNano + dust;

    const id = genId('d_');
    const comment = genId('c_');
    const now = Date.now();

    db.prepare(
      "INSERT INTO deposits(id,address,amount_nano,comment,status,created_at) VALUES (?,?,?,?,?,?)"
    ).run(id, s.address, Number(amountNano), comment, 'pending', now);

    const amountTonStr = nanoToTonStr(amountNano);
    res.json({
      ok: true,
      to: TREASURY_ADDRESS,
      amount_nano: amountNano.toString(),
      amount_ton: amountTonStr,
      validUntil: Math.floor(Date.now() / 1000) + 600,
      note: `Комментарий: ${comment}`,
      deposit: { id, status: 'pending', amountNano: amountNano.toString(), amountTon: amountTonStr, comment },
      pay: { to: TREASURY_ADDRESS, amountNano: amountNano.toString(), amountTon: amountTonStr, comment }
    });
  } catch (e) {
    jsonError(res, e);
  }
});

app.get('/api/deposit/mine', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const rows = db.prepare(
      "SELECT id, amount_nano, comment, status, tx_hash, created_at, confirmed_at FROM deposits WHERE address=? ORDER BY created_at DESC LIMIT 50"
    ).all(s.address);

    res.json({
      ok: true,
      deposits: rows.map(r => ({
        ...r,
        amount_ton: nanoToTonStr(r.amount_nano),
      }))
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---- Spend / Refund (used by game + pvp) ----
app.post('/api/spend', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const { amount_ton, amountTon, reason } = req.body || {};
    const amtAny = amountTon ?? amount_ton;
    const amtNum = Number(amtAny);
    if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error('bad amount');

    const amountNano = tonToNanoBig(amtAny);
    const bal = getBalanceNano(s.address);
    if (bal < amountNano) throw new Error('Недостаточно средств');

    const why = (reason || 'spend').toString();

    // списываем
    addLedger(s.address, -amountNano, why, null);

    // если это старт игры — создаём game_run
    if (why === 'game_start') {
      const gameRunId = genId('g_');
      db.prepare(
        "INSERT INTO game_runs(id,address,bet_nano,status,started_at) VALUES (?,?,?,?,?)"
      ).run(gameRunId, s.address, Number(amountNano), 'started', Date.now());

      res.json({
        ok: true,
        spent_ton: amtNum,
        spent_nano: amountNano.toString(),
        game_run_id: gameRunId
      });
      return;
    }

    res.json({ ok: true, spent_ton: amtNum, spent_nano: amountNano.toString() });
  } catch (e) {
    jsonError(res, e);
  }
});

// Возврат (если надо): вернёт amount_ton обратно на баланс
app.post('/api/refund', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const { amount_ton, amountTon, reason } = req.body || {};
    const amtAny = amountTon ?? amount_ton;
    const amtNum = Number(amtAny);
    if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error('bad amount');

    const amountNano = tonToNanoBig(amtAny);
    addLedger(s.address, amountNano, (reason || 'refund').toString(), null);

    res.json({ ok: true, refund_ton: amtNum, refund_nano: amountNano.toString() });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---- Game finish: payout by score ----
// принимает: { game_run_id, score }
// возвращает: { multiplier, reward_ton }
app.post('/api/game/finish', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const { game_run_id, score } = req.body || {};
    if (!game_run_id) throw new Error('game_run_id required');

    const sc = Number(score);
    if (!Number.isFinite(sc) || sc < 0) throw new Error('bad score');

    const run = db.prepare("SELECT * FROM game_runs WHERE id=?").get(game_run_id);
    if (!run) throw new Error('game_run_not_found');
    if (run.address !== s.address) throw new Error('not_your_game');

    // если уже завершено — вернуть сохранённое
    if (run.status === 'finished') {
      const mult = run.reward_nano && run.bet_nano ? Number(BigInt(run.reward_nano) / BigInt(run.bet_nano)) : 0;
      res.json({
        ok: true,
        multiplier: mult || 0,
        reward_ton: run.reward_nano ? Number(nanoToTonStr(run.reward_nano)) : 0,
        reward_nano: String(run.reward_nano || 0),
        score: run.score ?? sc
      });
      return;
    }

    // мультипликатор по тест-порогам
    let multiplier = 0;
    if (sc >= TETRIS_T3) multiplier = TETRIS_M3;
    else if (sc >= TETRIS_T2) multiplier = TETRIS_M2;
    else if (sc >= TETRIS_T1) multiplier = TETRIS_M1;
    else multiplier = 0;

    const betNano = BigInt(run.bet_nano);
    const rewardNano = multiplier > 0 ? betNano * BigInt(multiplier) : 0n;

    // сохраняем run
    db.prepare("UPDATE game_runs SET status='finished', finished_at=?, score=?, reward_nano=? WHERE id=?")
      .run(Date.now(), sc, Number(rewardNano), game_run_id);

    // начисляем награду (если есть)
    if (rewardNano > 0n) {
      addLedger(s.address, rewardNano, 'tetris_reward', game_run_id);
    }

    res.json({
      ok: true,
      multiplier,
      reward_ton: rewardNano > 0n ? Number(nanoToTonStr(rewardNano)) : 0,
      reward_nano: rewardNano.toString(),
      score: sc
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---- Withdrawals mine (history) ----
app.get('/api/withdraw/mine', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');
    const rows = db.prepare(
      "SELECT id, amount_nano, to_address, status, created_at, decided_at, note FROM withdrawals WHERE address=? ORDER BY created_at DESC LIMIT 50"
    ).all(s.address);
    res.json({ ok: true, withdrawals: rows });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---- Admin: manual credit ----
app.post('/api/admin/credit', (req, res) => {
  try {
    mustAdmin(req);
    const { address, amountTon, note } = req.body || {};
    if (!address) throw new Error('address required');

    const amt = Number(amountTon);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('bad amountTon');

    const nano = tonToNanoBig(amt);
    ensureUser(address);
    addLedger(address, nano, 'admin_credit', note || 'manual admin credit');

    res.json({ ok: true, address, added_ton: amt, added_nano: nano.toString() });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---- Withdraw routes (admin list/approve/reject + auto payout) ----
registerWithdrawRoutes(app);

// ---- Health ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`SERVER OK http://localhost:${PORT}`);
  console.log(`[server] treasury: ${TREASURY_ADDRESS}`);
  console.log(`[server] GAME_ENTRY_TON=${GAME_ENTRY_TON} thresholds: ${TETRIS_T1}/${TETRIS_T2}/${TETRIS_T3}`);
});

// --- Run poller inside the same service (so it shares the SAME SQLite DB on the disk) ---
if (process.env.RUN_POLLER === '1') {
  console.log('[server] Starting poller in background (RUN_POLLER=1)...');
  import('./poller.js')
    .then(() => console.log('[server] Poller module loaded'))
    .catch((e) => console.error('[server] Failed to start poller:', e));
}

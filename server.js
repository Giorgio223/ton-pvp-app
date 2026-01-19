// server.js (ESM) — Postgres version
// Runs main API + static + admin PG helpers + optional poller in same service

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import {
  pool,
  initDb,
  ensureUser,
  getSession as dbGetSession,
  getBalanceNano,
  addLedger,
} from './db.js';

import { registerWithdrawRoutes } from './withdraw_routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT || '3000');
const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || '').trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

const MIN_DEPOSIT_TON = Number(process.env.MIN_DEPOSIT_TON || '0.1');

const GAME_ENTRY_TON = Number(process.env.GAME_ENTRY_TON || '0.5');
const TETRIS_T1 = Number(process.env.TETRIS_T1 || '1000');
const TETRIS_T2 = Number(process.env.TETRIS_T2 || '2000');
const TETRIS_T3 = Number(process.env.TETRIS_T3 || '3000');
const TETRIS_M1 = Number(process.env.TETRIS_M1 || '1');
const TETRIS_M2 = Number(process.env.TETRIS_M2 || '2');
const TETRIS_M3 = Number(process.env.TETRIS_M3 || '3');

if (!TREASURY_ADDRESS) {
  console.error('[server] TREASURY_ADDRESS missing');
  process.exit(1);
}

initDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Static
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Helpers
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
  res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
}

function readSessionToken(req) {
  return (req.query.token ||
    req.headers['x-session-token'] ||
    (req.body && req.body.token) ||
    '').toString();
}

async function getSession(req) {
  const token = readSessionToken(req);
  return dbGetSession(token);
}

/* ------------------------- API ------------------------- */

// Create session
app.post('/api/session', async (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) throw new Error('address required');

    await ensureUser(address);

    const token = genId('s_');
    const now = Date.now();

    await pool.query(
      `INSERT INTO sessions(token,address,created_at,last_seen)
       VALUES ($1,$2,$3,$4)`,
      [token, address, now, now]
    );

    res.json({ ok: true, token, address });
  } catch (e) {
    jsonError(res, e);
  }
});

// Me / balance
app.get('/api/me', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const balNano = await getBalanceNano(s.address);

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

// Deposit create
app.post('/api/deposit/create', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const amountTonAny = (req.body?.amountTon ?? req.body?.amount_ton);
    const amtTonNum = Number(amountTonAny);
    if (!Number.isFinite(amtTonNum) || amtTonNum <= 0) throw new Error('bad amount');
    if (amtTonNum < MIN_DEPOSIT_TON) throw new Error(`Минимальный депозит: ${MIN_DEPOSIT_TON} TON`);

    const baseNano = tonToNanoBig(amountTonAny);
    const dust = BigInt(1 + crypto.randomInt(9999));
    const amountNano = baseNano + dust;

    const id = genId('d_');
    const comment = genId('c_');
    const now = Date.now();

    await pool.query(
      `INSERT INTO deposits(id,address,amount_nano,comment,status,created_at)
       VALUES ($1,$2,$3,$4,'pending',$5)`,
      [id, s.address, amountNano.toString(), comment, now]
    );

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

// Deposit mine
app.get('/api/deposit/mine', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const r = await pool.query(
      `SELECT id, amount_nano, comment, status, tx_hash, created_at, confirmed_at
       FROM deposits
       WHERE address=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [s.address]
    );

    res.json({
      ok: true,
      deposits: r.rows.map((row) => ({
        ...row,
        amount_ton: nanoToTonStr(row.amount_nano),
      }))
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// Spend (with optional game_start)
app.post('/api/spend', async (req, res) => {
  const client = await pool.connect();
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const amtAny = (req.body?.amountTon ?? req.body?.amount_ton);
    const amtNum = Number(amtAny);
    if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error('bad amount');

    const amountNano = tonToNanoBig(amtAny);
    const why = (req.body?.reason || 'spend').toString();

    await client.query('BEGIN');

    const balR = await client.query(
      `SELECT COALESCE(SUM(delta_nano),0)::bigint AS bal FROM ledger WHERE address=$1`,
      [s.address]
    );
    const bal = BigInt(balR.rows[0].bal);
    if (bal < amountNano) throw new Error('Недостаточно средств');

    await client.query(
      `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.address, (-amountNano).toString(), why, null, Date.now()]
    );

    if (why === 'game_start') {
      const gameRunId = genId('g_');
      await client.query(
        `INSERT INTO game_runs(id,address,bet_nano,status,started_at)
         VALUES ($1,$2,$3,'started',$4)`,
        [gameRunId, s.address, amountNano.toString(), Date.now()]
      );
      await client.query('COMMIT');
      return res.json({
        ok: true,
        spent_ton: amtNum,
        spent_nano: amountNano.toString(),
        game_run_id: gameRunId
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true, spent_ton: amtNum, spent_nano: amountNano.toString() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    jsonError(res, e);
  } finally {
    client.release();
  }
});

// Refund
app.post('/api/refund', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const amtAny = (req.body?.amountTon ?? req.body?.amount_ton);
    const amtNum = Number(amtAny);
    if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error('bad amount');

    const amountNano = tonToNanoBig(amtAny);
    await addLedger(s.address, amountNano, (req.body?.reason || 'refund').toString(), null);

    res.json({ ok: true, refund_ton: amtNum, refund_nano: amountNano.toString() });
  } catch (e) {
    jsonError(res, e);
  }
});

// Game finish
app.post('/api/game/finish', async (req, res) => {
  const client = await pool.connect();
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const game_run_id = (req.body?.game_run_id || '').toString();
    if (!game_run_id) throw new Error('game_run_id required');

    const sc = Number(req.body?.score);
    if (!Number.isFinite(sc) || sc < 0) throw new Error('bad score');

    await client.query('BEGIN');

    const runR = await client.query(
      `SELECT * FROM game_runs WHERE id=$1 FOR UPDATE`,
      [game_run_id]
    );
    if (!runR.rowCount) throw new Error('game_run_not_found');

    const run = runR.rows[0];
    if (run.address !== s.address) throw new Error('not_your_game');

    if (run.status === 'finished') {
      await client.query('COMMIT');
      return res.json({
        ok: true,
        multiplier: 0,
        reward_ton: run.reward_nano ? Number(nanoToTonStr(run.reward_nano)) : 0,
        reward_nano: String(run.reward_nano || 0),
        score: run.score ?? sc
      });
    }

    let multiplier = 0;
    if (sc >= TETRIS_T3) multiplier = TETRIS_M3;
    else if (sc >= TETRIS_T2) multiplier = TETRIS_M2;
    else if (sc >= TETRIS_T1) multiplier = TETRIS_M1;

    const betNano = BigInt(run.bet_nano);
    const rewardNano = multiplier > 0 ? betNano * BigInt(multiplier) : 0n;

    await client.query(
      `UPDATE game_runs
       SET status='finished', finished_at=$1, score=$2, reward_nano=$3
       WHERE id=$4`,
      [Date.now(), Math.trunc(sc), rewardNano.toString(), game_run_id]
    );

    if (rewardNano > 0n) {
      await client.query(
        `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [s.address, rewardNano.toString(), 'tetris_reward', game_run_id, Date.now()]
      );
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      multiplier,
      reward_ton: rewardNano > 0n ? Number(nanoToTonStr(rewardNano)) : 0,
      reward_nano: rewardNano.toString(),
      score: sc
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    jsonError(res, e);
  } finally {
    client.release();
  }
});

// Withdraw mine
app.get('/api/withdraw/mine', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const r = await pool.query(
      `SELECT id, amount_nano, to_address, status, created_at, decided_at, note
       FROM withdrawals
       WHERE address=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [s.address]
    );

    res.json({ ok: true, withdrawals: r.rows });
  } catch (e) {
    jsonError(res, e);
  }
});

// Admin credit
app.post('/api/admin/credit', async (req, res) => {
  try {
    mustAdmin(req);

    const address = (req.body?.address || '').toString().trim();
    if (!address) throw new Error('address required');

    const amt = Number(req.body?.amountTon);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('bad amountTon');

    const nano = tonToNanoBig(amt);

    await ensureUser(address);
    await addLedger(address, nano, 'admin_credit', (req.body?.note || 'manual admin credit').toString());

    res.json({ ok: true, address, added_ton: amt, added_nano: nano.toString() });
  } catch (e) {
    jsonError(res, e);
  }
});

/* ---------------------- Postgres helpers ---------------------- */

// PG health
app.get('/api/pg/health', async (_req, res) => {
  try {
    const r = await pool.query('select now() as now');
    res.json({ ok: true, postgres: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, postgres: false, error: e.message || String(e) });
  }
});

// Admin: apply schema (idempotent)
app.post('/api/admin/pg/apply-schema', async (req, res) => {
  try {
    mustAdmin(req);
    const sql = fs.readFileSync(path.join(__dirname, 'pg_schema.sql'), 'utf8');
    await pool.query(sql);
    res.json({ ok: true, applied: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// (Optional) keep old endpoint name; now it's already migrated
app.post('/api/admin/pg/migrate-from-sqlite', async (req, res) => {
  try {
    mustAdmin(req);
    res.json({ ok: true, migrated: false, note: 'Already migrated ранее. Этот endpoint больше не нужен.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/* ---------------------- Health + routes ---------------------- */

registerWithdrawRoutes(app);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`SERVER OK http://localhost:${PORT}`);
  console.log(`[server] treasury: ${TREASURY_ADDRESS}`);
  console.log(`[server] GAME_ENTRY_TON=${GAME_ENTRY_TON} thresholds: ${TETRIS_T1}/${TETRIS_T2}/${TETRIS_T3}`);
});

// Run poller inside the same service (optional)
if (process.env.RUN_POLLER === '1') {
  console.log('[server] Starting poller in background (RUN_POLLER=1)...');
  import('./poller.js')
    .then(() => console.log('[server] Poller module loaded'))
    .catch((e) => console.error('[server] Failed to start poller:', e));
}

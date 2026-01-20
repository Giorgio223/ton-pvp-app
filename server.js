// server.js (ESM) — Postgres PROD version + /admin protected by token + admin dashboard endpoints (BigInt-safe)
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
  console.error('[server] TREASURY_ADDRESS missing in .env');
  process.exit(1);
}

initDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- static ----------
app.use('/', express.static(path.join(__dirname, 'public')));

// ✅ Protect /admin pages with admin token (query ?token=... or header x-admin-token)
app.use('/admin', (req, res, next) => {
  const token = (req.query.token || req.headers['x-admin-token'] || '').toString();
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next();
  return res.status(401).send('Unauthorized');
});
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---------- helpers ----------
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

// ✅ Convert BigInt safely (JSON cannot serialize BigInt)
function toStr(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return null;
  return String(v);
}

function readSessionToken(req) {
  return (
    req.query.token ||
    req.headers['x-session-token'] ||
    (req.body && req.body.token) ||
    ''
  ).toString();
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

    res.json({
      ok: true,
      to: TREASURY_ADDRESS,
      amount_nano: amountNano.toString(),
      amount_ton: nanoToTonStr(amountNano),
      validUntil: Math.floor(Date.now() / 1000) + 600,
      note: `Комментарий: ${comment}`,
      deposit: { id, status: 'pending', amountNano: amountNano.toString(), amountTon: nanoToTonStr(amountNano), comment },
      pay: { to: TREASURY_ADDRESS, amountNano: amountNano.toString(), amountTon: nanoToTonStr(amountNano), comment }
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// Deposit mine (BigInt-safe)
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
        id: row.id,
        amount_nano: toStr(row.amount_nano),
        amount_ton: nanoToTonStr(row.amount_nano ?? 0),
        comment: row.comment,
        status: row.status,
        tx_hash: row.tx_hash,
        created_at: toStr(row.created_at),
        confirmed_at: toStr(row.confirmed_at),
      }))
    });
  } catch (e) {
    jsonError(res, e);
  }
});

/* ---------------------- ADMIN: dashboard endpoints ---------------------- */

// ADMIN: users + balances (BigInt-safe)
app.get('/api/admin/users', async (req, res) => {
  try {
    mustAdmin(req);

    const q = (req.query.q || '').toString().trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit || 200), 1000);

    const r = await pool.query(
      `
      SELECT
        u.address,
        u.created_at,
        COALESCE(SUM(l.delta_nano), 0)::bigint AS balance_nano
      FROM users u
      LEFT JOIN ledger l ON l.address = u.address
      GROUP BY u.address, u.created_at
      ORDER BY u.created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    let rows = r.rows;
    if (q) rows = rows.filter((x) => String(x.address).toLowerCase().includes(q));

    res.json({
      ok: true,
      users: rows.map((row) => ({
        address: row.address,
        created_at: toStr(row.created_at),
        balance_nano: toStr(row.balance_nano),
      })),
    });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
  }
});

// ADMIN: deposits list (BigInt-safe)
app.get('/api/admin/deposits', async (req, res) => {
  try {
    mustAdmin(req);

    const q = (req.query.q || '').toString().trim().toLowerCase();
    const status = (req.query.status || '').toString().trim();
    const limit = Math.min(Number(req.query.limit || 200), 1000);

    const params = [];
    let where = 'WHERE 1=1';

    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const sql = `
      SELECT id, address, amount_nano, comment, status, tx_hash, created_at, confirmed_at
      FROM deposits
      ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    const r = await pool.query(sql, params);

    let rows = r.rows;
    if (q) {
      rows = rows.filter((d) =>
        String(d.address || '').toLowerCase().includes(q) ||
        String(d.id || '').toLowerCase().includes(q)
      );
    }

    res.json({
      ok: true,
      deposits: rows.map((d) => ({
        id: d.id,
        address: d.address,
        amount_nano: toStr(d.amount_nano),
        comment: d.comment,
        status: d.status,
        tx_hash: d.tx_hash,
        created_at: toStr(d.created_at),
        confirmed_at: toStr(d.confirmed_at),
      })),
    });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
  }
});

/* ---------------------- user spend/refund/game ---------------------- */

// Spend (basic)
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

    await client.query('COMMIT');
    res.json({ ok: true, spent_ton: amtNum, spent_nano: amountNano.toString() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    jsonError(res, e);
  } finally {
    client.release();
  }
});

// Refund (admin-ish helper)
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

// Withdraw routes (admin + user)
registerWithdrawRoutes(app);

/* ---------------------- Health + helpers ---------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/pg/health', async (_req, res) => {
  try {
    const r = await pool.query('select now() as now');
    res.json({ ok: true, postgres: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, postgres: false, error: e.message || String(e) });
  }
});

/* ---------------------- PG ADMIN endpoints (optional) ---------------------- */

if (process.env.DISABLE_PG_ADMIN !== '1') {
  console.log('[server] PG admin endpoints ENABLED');

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

  app.post('/api/admin/pg/migrate-from-sqlite', async (req, res) => {
    try {
      mustAdmin(req);
      res.json({ ok: true, migrated: false, note: 'Already migrated ранее. Этот endpoint больше не нужен.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
} else {
  console.log('[server] PG admin endpoints DISABLED');
}

/* ---------------------- start ---------------------- */

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

// server.js (ESM) — Postgres PROD version
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

// ---------- static ----------
app.use('/', express.static(path.join(__dirname, 'public')));
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

// ---------- API ----------

// session
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

// me
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

// deposit create
app.post('/api/deposit/create', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const amtAny = req.body?.amountTon ?? req.body?.amount_ton;
    const amtNum = Number(amtAny);
    if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error('bad amount');
    if (amtNum < MIN_DEPOSIT_TON) throw new Error(`Минимум ${MIN_DEPOSIT_TON} TON`);

    const baseNano = tonToNanoBig(amtAny);
    const dust = BigInt(1 + crypto.randomInt(9999));
    const amountNano = baseNano + dust;

    const id = genId('d_');
    const comment = genId('c_');

    await pool.query(
      `INSERT INTO deposits(id,address,amount_nano,comment,status,created_at)
       VALUES ($1,$2,$3,$4,'pending',$5)`,
      [id, s.address, amountNano.toString(), comment, Date.now()]
    );

    res.json({
      ok: true,
      to: TREASURY_ADDRESS,
      amount_nano: amountNano.toString(),
      amount_ton: nanoToTonStr(amountNano),
      comment,
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// deposits mine
app.get('/api/deposit/mine', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const r = await pool.query(
      `SELECT id,amount_nano,status,tx_hash,created_at,confirmed_at
       FROM deposits WHERE address=$1
       ORDER BY created_at DESC LIMIT 50`,
      [s.address]
    );

    res.json({
      ok: true,
      deposits: r.rows.map((d) => ({
        ...d,
        amount_ton: nanoToTonStr(d.amount_nano),
      })),
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// spend
app.post('/api/spend', async (req, res) => {
  const client = await pool.connect();
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const amtAny = req.body?.amountTon ?? req.body?.amount_ton;
    const amtNum = Number(amtAny);
    if (!Number.isFinite(amtNum) || amtNum <= 0) throw new Error('bad amount');

    const amountNano = tonToNanoBig(amtAny);

    await client.query('BEGIN');

    const balR = await client.query(
      `SELECT COALESCE(SUM(delta_nano),0)::bigint AS bal FROM ledger WHERE address=$1`,
      [s.address]
    );
    if (BigInt(balR.rows[0].bal) < amountNano)
      throw new Error('Недостаточно средств');

    await client.query(
      `INSERT INTO ledger(address,delta_nano,reason,created_at)
       VALUES ($1,$2,'spend',$3)`,
      [s.address, (-amountNano).toString(), Date.now()]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    jsonError(res, e);
  } finally {
    client.release();
  }
});

// withdraw + admin withdraw routes
registerWithdrawRoutes(app);

// ---------- health ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/pg/health', async (_req, res) => {
  try {
    const r = await pool.query('select now() as now');
    res.json({ ok: true, postgres: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ---------- PG ADMIN (DISABLED IN PROD) ----------
if (process.env.DISABLE_PG_ADMIN !== '1') {
  console.log('[server] PG admin endpoints ENABLED');

  app.post('/api/admin/pg/apply-schema', async (req, res) => {
    try {
      mustAdmin(req);
      const sql = fs.readFileSync(path.join(__dirname, 'pg_schema.sql'), 'utf8');
      await pool.query(sql);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
} else {
  console.log('[server] PG admin endpoints DISABLED');
}

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`SERVER OK http://localhost:${PORT}`);
  console.log(`[server] treasury: ${TREASURY_ADDRESS}`);
  console.log(
    `[server] GAME_ENTRY_TON=${GAME_ENTRY_TON} thresholds ${TETRIS_T1}/${TETRIS_T2}/${TETRIS_T3}`
  );
});

// ---------- poller ----------
if (process.env.RUN_POLLER === '1') {
  console.log('[server] Starting poller in background (RUN_POLLER=1)...');
  import('./poller.js')
    .then(() => console.log('[server] Poller module loaded'))
    .catch((e) => console.error('[server] Poller failed:', e));
}

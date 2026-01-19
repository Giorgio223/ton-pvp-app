// server.js (ESM) — TON PVP + Block Puzzle backend (FULL)
// SQLite (prod now) + Postgres (migration ready)

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

import { db, initDb, ensureUser, getBalanceNano, addLedger } from './db.js';
import { registerWithdrawRoutes } from './withdraw_routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT || '3000');
const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || '').trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

const MIN_DEPOSIT_TON = Number(process.env.MIN_DEPOSIT_TON || '0.1');
const MIN_WITHDRAW_TON = Number(process.env.MIN_WITHDRAW_TON || '0.1');

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

// ---------- SQLITE INIT ----------
initDb();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- STATIC ----------
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---------- HELPERS ----------
function tonToNanoBig(ton) {
  const s = String(ton);
  const [a, b = ''] = s.split('.');
  return BigInt(a) * 1000000000n + BigInt((b + '000000000').slice(0, 9));
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

function getSession(req) {
  const token =
    (req.query.token ||
      req.headers['x-session-token'] ||
      (req.body && req.body.token) ||
      '').toString();
  if (!token) return null;
  const s = db.prepare('SELECT token,address FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  db.prepare('UPDATE sessions SET last_seen=? WHERE token=?').run(Date.now(), token);
  return s;
}

// ---------- API ----------

// session
app.post('/api/session', (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) throw new Error('address required');
    ensureUser(address);
    const token = genId('s_');
    db.prepare(
      'INSERT INTO sessions(token,address,created_at,last_seen) VALUES (?,?,?,?)'
    ).run(token, address, Date.now(), Date.now());
    res.json({ ok: true, token, address });
  } catch (e) {
    jsonError(res, e);
  }
});

// me
app.get('/api/me', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');
    const bal = getBalanceNano(s.address);
    res.json({
      ok: true,
      address: s.address,
      balance_nano: bal.toString(),
      balance_ton: nanoToTonStr(bal),
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// deposit
app.post('/api/deposit/create', (req, res) => {
  try {
    const s = getSession(req);
    if (!s) throw new Error('no session');

    const amt = Number(req.body.amountTon ?? req.body.amount_ton);
    if (!amt || amt < MIN_DEPOSIT_TON) throw new Error('bad amount');

    const baseNano = tonToNanoBig(amt);
    const dust = BigInt(1 + Math.floor(Math.random() * 9999));
    const nano = baseNano + dust;

    const id = genId('d_');
    const comment = genId('c_');

    db.prepare(
      'INSERT INTO deposits(id,address,amount_nano,comment,status,created_at) VALUES (?,?,?,?,?,?)'
    ).run(id, s.address, Number(nano), comment, 'pending', Date.now());

    res.json({
      ok: true,
      to: TREASURY_ADDRESS,
      amount_nano: nano.toString(),
      amount_ton: nanoToTonStr(nano),
      comment,
    });
  } catch (e) {
    jsonError(res, e);
  }
});

// ---------- POSTGRES HEALTH ----------
app.get('/api/pg/health', async (_req, res) => {
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const r = await pool.query('select now()');
    await pool.end();
    res.json({ ok: true, postgres: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, postgres: false, error: e.message });
  }
});

// ---------- APPLY PG SCHEMA (ADMIN) ----------
app.post('/api/admin/pg/apply-schema', async (req, res) => {
  try {
    mustAdmin(req);
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');

    const sql = fs.readFileSync(path.join(__dirname, 'pg_schema.sql'), 'utf8');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(sql);
    await pool.end();

    res.json({ ok: true, applied: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// withdraws
registerWithdrawRoutes(app);

// health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`SERVER OK http://localhost:${PORT}`);
  console.log(`[server] treasury: ${TREASURY_ADDRESS}`);
});

// ---------- POLLER ----------
if (process.env.RUN_POLLER === '1') {
  console.log('[server] Starting poller in background (RUN_POLLER=1)...');
  import('./poller.js')
    .then(() => console.log('[server] Poller started'))
    .catch((e) => console.error('[server] Poller failed', e));
}

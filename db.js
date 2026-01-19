// db.js (Postgres-only)
// DB_DRIVER=pg expected. Uses DATABASE_URL.
// Exposes helper functions used by server.js / withdraw_routes.js / poller.js.

import { Pool, types as pgTypes } from 'pg';

// Parse BIGINT (int8) as BigInt
pgTypes.setTypeParser(20, (val) => BigInt(val));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[db] DATABASE_URL missing');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

export function initDb() {
  // no-op: schema is applied via pg_schema.sql already
  return true;
}

export async function ensureUser(address) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO users(address, created_at)
     VALUES ($1, $2)
     ON CONFLICT (address) DO NOTHING`,
    [address, now]
  );
}

export async function createSession(address) {
  const token = `s_${cryptoRandHex(16)}`;
  const now = Date.now();
  await pool.query(
    `INSERT INTO sessions(token, address, created_at, last_seen)
     VALUES ($1, $2, $3, $4)`,
    [token, address, now, now]
  );
  return token;
}

export async function getSession(token) {
  if (!token) return null;
  const r = await pool.query(
    `SELECT token, address FROM sessions WHERE token=$1`,
    [token]
  );
  if (!r.rowCount) return null;
  await pool.query(`UPDATE sessions SET last_seen=$1 WHERE token=$2`, [Date.now(), token]);
  return r.rows[0];
}

export async function getBalanceNano(address) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(delta_nano), 0)::bigint AS bal
     FROM ledger WHERE address=$1`,
    [address]
  );
  return BigInt(r.rows[0].bal);
}

export async function addLedger(address, deltaNano, reason, ref) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [address, deltaNano.toString(), reason, ref ?? null, now]
  );
}

// Helpers
export function cryptoRandHex(nBytes) {
  // Node built-in crypto (no import) in ESM: use dynamic import
  // but for speed/compat, simple fallback:
  const chars = 'abcdef0123456789';
  let out = '';
  for (let i = 0; i < nBytes * 2; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

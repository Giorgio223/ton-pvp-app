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

async function colExists(table, col) {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, col]
  );
  return r.rowCount > 0;
}

async function tableExists(table) {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1
     LIMIT 1`,
    [table]
  );
  return r.rowCount > 0;
}

export async function initDb() {
  // This function can be safely called on every start.
  // It creates/migrates tables needed for BONUS + referrals.

  try {
    // ---- bonus_claims ----
    if (!(await tableExists('bonus_claims'))) {
      await pool.query(`
        CREATE TABLE bonus_claims (
          address TEXT PRIMARY KEY,
          last_claim_at BIGINT NOT NULL DEFAULT 0
        );
      `);
    } else {
      // migrate old columns if they exist (wallet/last_claim -> address/last_claim_at)
      const hasWallet = await colExists('bonus_claims', 'wallet');
      const hasAddress = await colExists('bonus_claims', 'address');
      if (hasWallet && !hasAddress) {
        await pool.query(`ALTER TABLE bonus_claims RENAME COLUMN wallet TO address;`);
      }

      const hasLastClaim = await colExists('bonus_claims', 'last_claim');
      const hasLastClaimAt = await colExists('bonus_claims', 'last_claim_at');
      if (hasLastClaim && !hasLastClaimAt) {
        // try rename first
        await pool.query(`ALTER TABLE bonus_claims RENAME COLUMN last_claim TO last_claim_at;`);
      }

      // ensure last_claim_at exists and is BIGINT
      const nowHasLastClaimAt = await colExists('bonus_claims', 'last_claim_at');
      if (!nowHasLastClaimAt) {
        await pool.query(`ALTER TABLE bonus_claims ADD COLUMN last_claim_at BIGINT NOT NULL DEFAULT 0;`);
      }

      // If last_claim_at is not BIGINT (e.g. TIMESTAMP), create temp bigint and convert
      // This is best-effort; if table is empty, it just works.
      const t = await pool.query(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='bonus_claims' AND column_name='last_claim_at'
         LIMIT 1`
      );
      const dt = t.rowCount ? String(t.rows[0].data_type) : '';
      if (dt && dt !== 'bigint') {
        // convert to bigint milliseconds
        await pool.query(`ALTER TABLE bonus_claims ADD COLUMN IF NOT EXISTS last_claim_at_ms BIGINT NOT NULL DEFAULT 0;`);
        // if timestamp -> epoch ms, if text/numeric -> try cast
        await pool.query(`
          UPDATE bonus_claims
          SET last_claim_at_ms =
            CASE
              WHEN pg_typeof(last_claim_at)::text LIKE '%timestamp%' THEN (EXTRACT(EPOCH FROM last_claim_at) * 1000)::bigint
              ELSE COALESCE(NULLIF(last_claim_at::text,''),'0')::bigint
            END
        `).catch(() => {});
        await pool.query(`ALTER TABLE bonus_claims DROP COLUMN last_claim_at;`).catch(() => {});
        await pool.query(`ALTER TABLE bonus_claims RENAME COLUMN last_claim_at_ms TO last_claim_at;`).catch(() => {});
      }
    }

    // ---- referrals ----
    if (!(await tableExists('referrals'))) {
      await pool.query(`
        CREATE TABLE referrals (
          id SERIAL PRIMARY KEY,
          user_address TEXT NOT NULL UNIQUE,
          referrer_address TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
      `);
    } else {
      // migrate old columns (referred_wallet/referrer_wallet -> user_address/referrer_address)
      const hasReferredWallet = await colExists('referrals', 'referred_wallet');
      const hasUserAddress = await colExists('referrals', 'user_address');
      if (hasReferredWallet && !hasUserAddress) {
        await pool.query(`ALTER TABLE referrals RENAME COLUMN referred_wallet TO user_address;`).catch(() => {});
      }

      const hasReferrerWallet = await colExists('referrals', 'referrer_wallet');
      const hasReferrerAddress = await colExists('referrals', 'referrer_address');
      if (hasReferrerWallet && !hasReferrerAddress) {
        await pool.query(`ALTER TABLE referrals RENAME COLUMN referrer_wallet TO referrer_address;`).catch(() => {});
      }

      const hasCreatedAt = await colExists('referrals', 'created_at');
      if (!hasCreatedAt) {
        await pool.query(`ALTER TABLE referrals ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0;`).catch(() => {});
      }

      // ensure unique constraint on user_address
      if (await colExists('referrals', 'user_address')) {
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS referrals_user_address_uq ON referrals(user_address);`).catch(() => {});
      }
    }

    // ---- referral_balances ----
    if (!(await tableExists('referral_balances'))) {
      await pool.query(`
        CREATE TABLE referral_balances (
          address TEXT PRIMARY KEY,
          pending_nano BIGINT NOT NULL DEFAULT 0
        );
      `);
    } else {
      const hasWallet = await colExists('referral_balances', 'wallet');
      const hasAddress = await colExists('referral_balances', 'address');
      if (hasWallet && !hasAddress) {
        await pool.query(`ALTER TABLE referral_balances RENAME COLUMN wallet TO address;`).catch(() => {});
      }

      const hasBalance = await colExists('referral_balances', 'balance');
      const hasPending = await colExists('referral_balances', 'pending_nano');
      if (hasBalance && !hasPending) {
        // rename balance -> pending_nano (best effort)
        await pool.query(`ALTER TABLE referral_balances RENAME COLUMN balance TO pending_nano;`).catch(() => {});
      }

      const nowHasPending = await colExists('referral_balances', 'pending_nano');
      if (!nowHasPending) {
        await pool.query(`ALTER TABLE referral_balances ADD COLUMN pending_nano BIGINT NOT NULL DEFAULT 0;`).catch(() => {});
      }

      // if pending_nano not bigint, try to coerce
      const t2 = await pool.query(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='referral_balances' AND column_name='pending_nano'
         LIMIT 1`
      );
      const dt2 = t2.rowCount ? String(t2.rows[0].data_type) : '';
      if (dt2 && dt2 !== 'bigint') {
        await pool.query(`ALTER TABLE referral_balances ADD COLUMN IF NOT EXISTS pending_nano_i8 BIGINT NOT NULL DEFAULT 0;`);
        await pool.query(`
          UPDATE referral_balances
          SET pending_nano_i8 = COALESCE(NULLIF(pending_nano::text,''),'0')::bigint
        `).catch(() => {});
        await pool.query(`ALTER TABLE referral_balances DROP COLUMN pending_nano;`).catch(() => {});
        await pool.query(`ALTER TABLE referral_balances RENAME COLUMN pending_nano_i8 TO pending_nano;`).catch(() => {});
      }
    }

    console.log('[db] init ok');
  } catch (e) {
    console.error('[db] init failed:', e?.message || e);
    throw e;
  }
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
  const chars = 'abcdef0123456789';
  let out = '';
  for (let i = 0; i < nBytes * 2; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

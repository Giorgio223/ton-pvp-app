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
// Payout thresholds (score)
// x5 reward starts from 10,000 (was 25,000)
const TETRIS_T1 = Number(process.env.TETRIS_T1 || '10000');
const TETRIS_T2 = Number(process.env.TETRIS_T2 || '50000');
const TETRIS_T3 = Number(process.env.TETRIS_T3 || '100000');
const TETRIS_M1 = Number(process.env.TETRIS_M1 || '5');
const TETRIS_M2 = Number(process.env.TETRIS_M2 || '50');
const TETRIS_M3 = Number(process.env.TETRIS_M3 || '100');

// Fixed reward mode (UI expects "забрать выигрыш 2.5 TON" when score >= 10000)
// You can override via env if needed.
const TETRIS_FIXED_REWARD_TON = (process.env.TETRIS_FIXED_REWARD_TON || '2.5').toString();
const TETRIS_FIXED_REWARD_NANO = tonToNanoBig(TETRIS_FIXED_REWARD_TON);

if (!TREASURY_ADDRESS) {
  console.error('[server] TREASURY_ADDRESS missing in .env');
  process.exit(1);
}

initDb();
(async () => {
  // Ensure bonus_claims has unique constraint for ON CONFLICT (address)
  try {
    await pool.query(`ALTER TABLE bonus_claims ADD COLUMN IF NOT EXISTS address TEXT;`).catch(()=>{});
    // If old schema used wallet column, copy it once
    await pool.query(`UPDATE bonus_claims SET address = COALESCE(address, wallet) WHERE address IS NULL AND wallet IS NOT NULL;`).catch(()=>{});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS bonus_claims_address_uq ON bonus_claims(address);`).catch(()=>{});
  } catch (e) {
    console.warn('[db] bonus_claims migrate warning:', e?.message || e);
  }
})();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));


// Dynamic TonConnect manifest (avoids constant manual edits on domain changes)
app.get('/tonconnect-manifest.json', (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const host = req.get('host');
  const origin = `${proto}://${host}`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({
    url: origin,
    name: 'TON PVP',
    iconUrl: origin + '/icon.png',
    termsOfUseUrl: origin,
    privacyPolicyUrl: origin,
  });
});

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

    const now = Date.now();

    // Attach referral on first session creation (only once)
    const ref = (req.body?.ref || req.query?.ref || "").toString().trim();
    if (ref && ref !== address) {
      try {
        await ensureUser(ref);
        await pool.query(
          `INSERT INTO referrals(user_address, referrer_address, created_at)
           VALUES ($1,$2,$3)
           ON CONFLICT (user_address) DO NOTHING`,
          [address, ref, now]
        );
      } catch (e) {
        // ignore referral errors to not break login
      }
    }

    const token = genId('s_');

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



// ---------- BONUS (0.1 TON / 12h) ----------
const BONUS_AMOUNT_TON = Number(process.env.BONUS_AMOUNT_TON || '0.1');
const BONUS_INTERVAL_HOURS = Number(process.env.BONUS_INTERVAL_HOURS || '12');
const BONUS_MIN_TOTAL_DEPOSIT_TON = Number(process.env.BONUS_MIN_TOTAL_DEPOSIT_TON || '3');

async function getTotalDepositedNano(address) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(delta_nano),0)::bigint AS s
     FROM ledger
     WHERE address=$1 AND reason='deposit' AND delta_nano > 0`,
    [address]
  );
  return BigInt(r.rows[0].s);
}

app.get('/api/bonus/status', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const totalDepNano = await getTotalDepositedNano(s.address);
    const minNano = tonToNanoBig(BONUS_MIN_TOTAL_DEPOSIT_TON);
    const eligible = totalDepNano >= minNano;

    const r = await pool.query(
      `SELECT last_claim_at FROM bonus_claims WHERE address=$1`,
      [s.address]
    );
    const last = r.rowCount ? Number(r.rows[0].last_claim_at) : 0;
    const intervalMs = BONUS_INTERVAL_HOURS * 60 * 60 * 1000;
    const next = last + intervalMs;
    const now = Date.now();
    const can_claim = eligible && (last == 0 || now >= next);

    res.json({
      ok: true,
      eligible,
      total_deposit_ton: nanoToTonStr(totalDepNano),
      min_required_ton: String(BONUS_MIN_TOTAL_DEPOSIT_TON),
      bonus_amount_ton: String(BONUS_AMOUNT_TON),
      interval_hours: BONUS_INTERVAL_HOURS,
      last_claim_at: last,
      next_claim_at: can_claim ? now : next,
      can_claim,
    });
  } catch (e) {
    jsonError(res, e);
  }
});

app.post('/api/bonus/claim', async (req, res) => {
  const client = await pool.connect();
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const totalDepNano = await getTotalDepositedNano(s.address);
    const minNano = tonToNanoBig(BONUS_MIN_TOTAL_DEPOSIT_TON);
    if (totalDepNano < minNano) throw new Error('not_eligible');

    const intervalMs = BONUS_INTERVAL_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    await client.query('BEGIN');

    const r = await client.query(
      `SELECT last_claim_at FROM bonus_claims WHERE address=$1 FOR UPDATE`,
      [s.address]
    );
    const last = r.rowCount ? Number(r.rows[0].last_claim_at) : 0;
    const next = last + intervalMs;
    if (last != 0 && now < next) throw new Error('too_early');

    await client.query(
      `INSERT INTO bonus_claims(address,last_claim_at)
       VALUES ($1,$2)
       ON CONFLICT (address) DO UPDATE SET last_claim_at=EXCLUDED.last_claim_at`,
      [s.address, now]
    );

    const amountNano = tonToNanoBig(BONUS_AMOUNT_TON);
    await client.query(
      `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.address, amountNano.toString(), 'bonus_claim', null, now]
    );

    await client.query('COMMIT');

    res.json({ ok: true, amount_ton: String(BONUS_AMOUNT_TON), amount_nano: amountNano.toString() });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    jsonError(res, e);
  } finally {
    client.release();
  }
});

// ---------- REFERRALS ----------
app.get('/api/referral/status', async (req, res) => {
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    const inv = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM referrals WHERE referrer_address=$1`,
      [s.address]
    );
    const count = BigInt(inv.rows[0].c);

    const bal = await pool.query(
      `SELECT pending_nano FROM referral_balances WHERE address=$1`,
      [s.address]
    );
    const pending = bal.rowCount ? BigInt(bal.rows[0].pending_nano) : 0n;

    res.json({
      ok: true,
      invited_count: count.toString(),
      pending_nano: pending.toString(),
      pending_ton: nanoToTonStr(pending),
    });
  } catch (e) {
    jsonError(res, e);
  }
});

app.post('/api/referral/claim', async (req, res) => {
  const client = await pool.connect();
  try {
    const s = await getSession(req);
    if (!s) throw new Error('no session');

    await client.query('BEGIN');
    const r = await client.query(
      `SELECT pending_nano FROM referral_balances WHERE address=$1 FOR UPDATE`,
      [s.address]
    );
    const pending = r.rowCount ? BigInt(r.rows[0].pending_nano) : 0n;
    if (pending <= 0n) throw new Error('nothing_to_claim');

    await client.query(
      `UPDATE referral_balances SET pending_nano=0 WHERE address=$1`,
      [s.address]
    );

    await client.query(
      `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.address, pending.toString(), 'referral_claim', null, Date.now()]
    );

    await client.query('COMMIT');
    res.json({ ok: true, claimed_nano: pending.toString(), claimed_ton: nanoToTonStr(pending) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    jsonError(res, e);
  } finally {
    client.release();
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
      const rewardTonStr = run.reward_nano ? nanoToTonStr(run.reward_nano) : '0';
      return res.json({
        ok: true,
        multiplier: 0,
        reward_ton: run.reward_nano ? Number(rewardTonStr) : 0,
        reward_ton_str: rewardTonStr,
        reward_nano: String(run.reward_nano || 0),
        score: run.score ?? sc
      });
    }

    // Fixed reward logic (requested):
    // If score >= TETRIS_T1 (default 10,000) — credit a fixed 2.5 TON to the player's balance.
    // Otherwise — no reward.
    const betNano = BigInt(run.bet_nano);
    const rewardNano = sc >= TETRIS_T1 ? TETRIS_FIXED_REWARD_NANO : 0n;
    const multiplier = rewardNano > 0n ? 1 : 0;

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

    // Referral reward: 10% of bet for the referrer, only when game is finished
    try {
      const refR = await client.query(
        `SELECT referrer_address FROM referrals WHERE user_address=$1`,
        [s.address]
      );
      if (refR.rowCount) {
        const refAddr = refR.rows[0].referrer_address;
        if (refAddr && refAddr !== s.address) {
          const refBonus = betNano / 10n;
          if (refBonus > 0n) {
            await client.query(
              `INSERT INTO referral_balances(address, pending_nano)
               VALUES ($1,$2)
               ON CONFLICT (address) DO UPDATE
               SET pending_nano = referral_balances.pending_nano + EXCLUDED.pending_nano`,
              [refAddr, refBonus.toString()]
            );
          }
        }
      }
    } catch (e) {
      // ignore referral errors
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      multiplier,
      reward_ton: rewardNano > 0n ? Number(nanoToTonStr(rewardNano)) : 0,
      reward_ton_str: rewardNano > 0n ? nanoToTonStr(rewardNano) : '0',
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

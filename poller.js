// poller.js (Postgres)
// Confirms pending deposits by matching amount_nano against TonAPI transactions.

import { pool } from './db.js';

const TREASURY_ADDRESS = (process.env.TREASURY_ADDRESS || '').trim();
const TONAPI_API_KEY = (process.env.TONAPI_API_KEY || '').trim();

const TONAPI_BASE = 'https://tonapi.io';

async function tonapiFetch(path) {
  const r = await fetch(`${TONAPI_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${TONAPI_API_KEY}`,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`TonAPI ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function scanIncomingTreasury(limit = 80) {
  const addr = encodeURIComponent(TREASURY_ADDRESS);
  const data = await tonapiFetch(`/v2/blockchain/accounts/${addr}/transactions?limit=${limit}`);
  return data?.transactions || data || [];
}

function extractIncomingNano(tx) {
  const v =
    tx?.in_msg?.value ??
    tx?.in_msg?.amount ??
    tx?.in_msg?.value_nano ??
    null;

  if (v == null) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function extractHash(tx) {
  return tx?.hash || tx?.transaction_id?.hash || tx?.id || null;
}

async function tick() {
  const pending = await pool.query(
    `SELECT id,address,amount_nano
     FROM deposits
     WHERE status='pending'
     ORDER BY created_at ASC
     LIMIT 50`
  );

  console.log(`[poller] pending deposits: ${pending.rowCount}`);
  if (!pending.rowCount) return;

  const txs = await scanIncomingTreasury(80);

  let confirmed = 0;

  for (const d of pending.rows) {
    const want = BigInt(d.amount_nano);
    const match = txs.find((tx) => extractIncomingNano(tx) === want);
    if (!match) continue;

    const txHash = extractHash(match);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cur = await client.query(
        `SELECT status FROM deposits WHERE id=$1 FOR UPDATE`,
        [d.id]
      );
      if (!cur.rowCount || cur.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        continue;
      }

      await client.query(
        `UPDATE deposits
         SET status='confirmed', tx_hash=$1, confirmed_at=$2
         WHERE id=$3`,
        [txHash, Date.now(), d.id]
      );

      await client.query(
        `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [d.address, want.toString(), 'deposit', d.id, Date.now()]
      );

      await client.query('COMMIT');

      console.log(`[poller] CONFIRM deposit id=${d.id} user=${d.address} nano=${want.toString()} tx=${txHash}`);
      confirmed++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('[poller] confirm failed:', e.message || String(e));
    } finally {
      client.release();
    }
  }

  console.log(`[poller] confirmed this tick: ${confirmed}`);
}

async function loop() {
  if (!TREASURY_ADDRESS) {
    console.log('[poller] TREASURY_ADDRESS missing — poller disabled');
    return;
  }
  if (!TONAPI_API_KEY) {
    console.log('[poller] TONAPI_API_KEY пустой — poller отключен (web не падает)');
    return;
  }

  console.log('[poller] started');
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.log('[poller] tick error:', e.message || String(e));
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

loop();

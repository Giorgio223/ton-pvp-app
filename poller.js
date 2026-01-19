// poller.js (ESM) — автоподтверждение депозитов через TonAPI + зачисление в ledger
//
// Под твою БД (см. db.js):
// deposits(id, address, amount_nano, comment, status, tx_hash, tx_lt, created_at, confirmed_at)
// ledger(address, delta_nano, reason, ref, created_at)
// Баланс = SUM(ledger.delta_nano)
//
// Запуск: node poller.js
// ВАЖНО: проект ESM ("type":"module"), поэтому используем import.

// ВАЖНО: dotenv по умолчанию ищет .env в текущей рабочей папке (cwd).
// Если poller запущен не из папки проекта, ключи TONAPI/адреса не подхватятся.
// Поэтому грузим .env относительно этого файла.
import dotenv from 'dotenv';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

import { db, ensureUser, addLedger } from './db.js';

const TREASURY = (process.env.TREASURY_ADDRESS || '').trim();
const TONAPI_KEY = (process.env.TONAPI_API_KEY || '').trim();

if (!TREASURY) {
  console.error('[poller] TREASURY_ADDRESS пустой в .env');
  process.exit(1);
}
if (!TONAPI_KEY) {
  console.error('[poller] TONAPI_API_KEY пустой в .env');
  process.exit(1);
}

const POLL_INTERVAL_MS = 10_000;
const TX_LIMIT = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tonapiGetTreasuryTxs(address, limit = 50) {
  const url = `https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(address)}/transactions?limit=${limit}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TONAPI_KEY}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`TonAPI ${r.status}: ${t}`);
  }
  return await r.json();
}

/**
 * Мы запрашиваем транзакции конкретно TREASURY-аккаунта,
 * поэтому НЕ проверяем destination (часто ломается из-за EQ/UQ/форматов).
 * Индексируем по amount_nano (строкой) -> {hash, lt}
 */
function indexIncomingByAmount(tonapiJson) {
  const txs = tonapiJson?.transactions || [];
  const map = new Map();

  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;

    const amountNano = String(inMsg.value ?? inMsg.amount ?? '');
    if (!amountNano) continue;

    const hash = tx.hash || tx.transaction_id?.hash || tx.id || '';
    const lt = tx.lt || tx.transaction_id?.lt || '';

    // Важно: если две транзы на одинаковую сумму — мы берём самую свежую (первую в списке TonAPI)
    if (!map.has(amountNano)) {
      map.set(amountNano, { hash, lt });
    }
  }

  return map;
}

function getPendingDeposits() {
  return db.prepare(
    "SELECT id, address, amount_nano FROM deposits WHERE status='pending' ORDER BY created_at ASC LIMIT 200"
  ).all();
}

function markDepositConfirmed(id, txHash, txLt) {
  const now = Date.now();
  db.prepare(
    "UPDATE deposits SET status='confirmed', tx_hash=?, tx_lt=?, confirmed_at=? WHERE id=?"
  ).run(txHash || null, txLt || null, now, id);
}

function alreadyLedgered(ref) {
  const row = db.prepare("SELECT 1 AS ok FROM ledger WHERE ref = ? LIMIT 1").get(ref);
  return !!row;
}

async function tick() {
  const pending = getPendingDeposits();
  console.log(`[poller] pending deposits: ${pending.length}`);
  if (!pending.length) return;

  const txs = await tonapiGetTreasuryTxs(TREASURY, TX_LIMIT);
  const idx = indexIncomingByAmount(txs);

  let confirmed = 0;

  for (const dep of pending) {
    const amountNanoStr = String(dep.amount_nano);
    const found = idx.get(amountNanoStr);
    if (!found) continue;

    // Защита от повторного начисления
    if (alreadyLedgered(dep.id)) {
      // если ledger есть, но deposit почему-то всё ещё pending — поправим статус
      markDepositConfirmed(dep.id, found.hash, found.lt);
      continue;
    }

    console.log(
      `[poller] CONFIRM deposit id=${dep.id} user=${dep.address} nano=${amountNanoStr} tx=${found.hash}`
    );

    // 1) подтвердить депозит
    markDepositConfirmed(dep.id, found.hash, found.lt);

    // 2) зачислить в ledger (ВАЖНО: delta_nano NOT NULL)
    ensureUser(dep.address);
    // addLedger(address, deltaNano, reason, ref)
    addLedger(dep.address, BigInt(dep.amount_nano), 'deposit', dep.id);

    confirmed++;
  }

  console.log(`[poller] confirmed this tick: ${confirmed}`);
}

async function main() {
  console.log('[poller] starting...');
  console.log('[poller] treasury:', TREASURY);
  console.log('[poller] interval(ms):', POLL_INTERVAL_MS);

  while (true) {
    try {
      await tick();
    } catch (e) {
      console.log('[poller] ERROR:', e?.message || e);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((e) => {
  console.error('[poller] FATAL:', e);
  process.exit(1);
});

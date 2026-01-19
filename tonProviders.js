import fetch from 'node-fetch';

export function nanoFromTon(ton) {
  const s = String(ton).trim();
  if (!s || !/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('Invalid TON amount');
  const [a, b = ''] = s.split('.');
  const frac = (b + '000000000').slice(0, 9);
  return BigInt(a) * 1000000000n + BigInt(frac);
}

export function tonFromNano(nano) {
  const n = BigInt(nano);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const a = abs / 1000000000n;
  const b = abs % 1000000000n;
  const frac = b.toString().padStart(9, '0').replace(/0+$/, '');
  return sign + a.toString() + (frac ? '.' + frac : '');
}

function pickComment(tx) {
  // Try multiple shapes depending on provider.
  // TONAPI often provides decoded message text.
  const candidates = [];

  // toncenter v2
  if (tx?.in_msg) {
    if (typeof tx.in_msg.message === 'string') candidates.push(tx.in_msg.message);
    if (typeof tx.in_msg.msg_data?.text === 'string') candidates.push(tx.in_msg.msg_data.text);
    if (typeof tx.in_msg.comment === 'string') candidates.push(tx.in_msg.comment);
  }

  // tonapi
  if (tx?.in_msg) {
    if (typeof tx.in_msg?.message === 'string') candidates.push(tx.in_msg.message);
    if (typeof tx.in_msg?.decoded_body?.comment === 'string') candidates.push(tx.in_msg.decoded_body.comment);
  }

  // generic
  if (typeof tx?.comment === 'string') candidates.push(tx.comment);

  for (const c of candidates) {
    const s = String(c).trim();
    if (s) return s;
  }
  return '';
}

function pickAmountNano(tx) {
  // toncenter: in_msg.value is string in nano
  if (tx?.in_msg?.value != null) {
    try { return BigInt(tx.in_msg.value); } catch {}
  }
  // tonapi: in_msg.value might be string nano too
  if (tx?.in_msg?.value != null) {
    try { return BigInt(tx.in_msg.value); } catch {}
  }
  // fallbacks
  if (tx?.amount != null) {
    try { return BigInt(tx.amount); } catch {}
  }
  return null;
}

function pickSource(tx) {
  const a = tx?.in_msg?.source || tx?.in_msg?.src || tx?.in_msg?.from || tx?.from;
  return a ? String(a) : '';
}

function pickTxId(tx) {
  // toncenter: transaction_id {lt, hash}
  if (tx?.transaction_id?.lt && tx?.transaction_id?.hash) {
    return { lt: String(tx.transaction_id.lt), hash: String(tx.transaction_id.hash) };
  }
  // tonapi: might have transaction_id or hash
  if (tx?.transaction_id) return { lt: String(tx.transaction_id.lt ?? ''), hash: String(tx.transaction_id.hash ?? tx.transaction_id) };
  if (tx?.hash) return { lt: String(tx.lt ?? ''), hash: String(tx.hash) };
  return { lt: '', hash: '' };
}

export async function fetchTreasuryTransactions({ provider, address, limit = 25, cursor }) {
  if (provider === 'toncenter') {
    const endpoint = process.env.TONCENTER_ENDPOINT || 'https://toncenter.com/api/v2';
    const apiKey = process.env.TONCENTER_API_KEY || '';
    const qs = new URLSearchParams({ address, limit: String(limit) });
    if (cursor?.lt && cursor?.hash) {
      qs.set('lt', cursor.lt);
      qs.set('hash', cursor.hash);
    }
    // toncenter supports api_key query param
    if (apiKey) qs.set('api_key', apiKey);

    const url = `${endpoint}/getTransactions?${qs.toString()}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) throw new Error(`toncenter error: ${JSON.stringify(json)}`);
    const txs = json.result || [];
    return txs.map((tx) => normalizeTx(tx));
  }

  if (provider === 'tonapi') {
    const endpoint = process.env.TONAPI_ENDPOINT || 'https://tonapi.io';
    const apiKey = process.env.TONAPI_API_KEY || '';
    const url = new URL(`${endpoint}/v2/blockchain/accounts/${encodeURIComponent(address)}/transactions`);
    url.searchParams.set('limit', String(limit));
    // tonapi uses 'before_lt' sometimes; if not supported, it ignores
    if (cursor?.lt) url.searchParams.set('before_lt', String(cursor.lt));

    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, { headers });
    const json = await res.json();
    const txs = json.transactions || json || [];
    if (!Array.isArray(txs)) throw new Error(`tonapi unexpected: ${JSON.stringify(json).slice(0, 200)}`);
    return txs.map((tx) => normalizeTx(tx));
  }

  throw new Error('Unknown provider');
}

export function normalizeTx(tx) {
  const id = pickTxId(tx);
  return {
    raw: tx,
    lt: id.lt,
    hash: id.hash,
    source: pickSource(tx),
    amount_nano: pickAmountNano(tx),
    comment: pickComment(tx)
  };
}

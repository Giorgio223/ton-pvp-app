// payout.js (ESM)
// Автовывод TON с treasury-кошелька (подпись на сервере).
//
// Требует в .env:
//   TON_NETWORK=mainnet            # или testnet
//   TONCENTER_API_KEY=...          # ключ Toncenter (mainnet/testnet)
//   TREASURY_MNEMONIC="word1 ... word24"  # 24 слова (НЕ коммить!)
//
// Установка зависимостей:
//   npm i @ton/ton @ton/crypto

import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

function requireEnv(name) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function sendTon({ toAddress, amountNano, comment = null }) {
  const network = (process.env.TON_NETWORK || 'mainnet').trim().toLowerCase();
  const apiKey = requireEnv('TONCENTER_API_KEY');
  const mnemonic = requireEnv('TREASURY_MNEMONIC');

  const endpoint =
    network === 'testnet'
      ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
      : 'https://toncenter.com/api/v2/jsonRPC';

  const client = new TonClient({ endpoint, apiKey });

  const words = mnemonic.split(/\s+/).filter(Boolean);
  const keyPair = await mnemonicToPrivateKey(words);

  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const walletContract = client.open(wallet);

  const seqno = await walletContract.getSeqno();

  const msg = comment
    ? internal({ to: toAddress, value: BigInt(amountNano), body: comment })
    : internal({ to: toAddress, value: BigInt(amountNano) });

  await walletContract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [msg],
  });

  // tx_hash тут не получаем синхронно (это нормально для MVP)
  return { seqno_before: seqno, endpoint, network };
}

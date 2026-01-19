// withdraw_routes.js (Postgres)
// Implements /api/withdraw/request, /api/admin/withdraw/list|approve|reject

import { pool, ensureUser, getBalanceNano, addLedger } from './db.js';
import { sendTon } from './payout.js';

function tonToNanoBig(ton) {
  const s = String(ton);
  const [a, b = ''] = s.split('.');
  return BigInt(a) * 1000000000n + BigInt((b + '000000000').slice(0, 9));
}

function mustAdmin(req) {
  const token = (req.query.token || req.headers['x-admin-token'] || '').toString();
  const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    const e = new Error('Unauthorized');
    e.status = 401;
    throw e;
  }
}

async function getSession(req) {
  const token = (req.query.token || req.headers['x-session-token'] || (req.body && req.body.token) || '').toString();
  if (!token) return null;
  const r = await pool.query(`SELECT token,address FROM sessions WHERE token=$1`, [token]);
  if (!r.rowCount) return null;
  await pool.query(`UPDATE sessions SET last_seen=$1 WHERE token=$2`, [Date.now(), token]);
  return r.rows[0];
}

export function registerWithdrawRoutes(app) {
  const MIN_WITHDRAW_TON = Number(process.env.MIN_WITHDRAW_TON || '0.1');
  const AUTO_PAYOUT_MAX_TON = Number(process.env.AUTO_PAYOUT_MAX_TON || '3');
  const DISABLE_PAYOUTS = (process.env.DISABLE_PAYOUTS || '') === '1';

  // user: request withdraw
  app.post('/api/withdraw/request', async (req, res) => {
    try {
      const s = await getSession(req);
      if (!s) throw new Error('no session');

      const to = (req.body?.to || req.body?.to_address || '').toString().trim();
      if (!to) throw new Error('to required');

      const amountTon = Number(req.body?.amountTon ?? req.body?.amount_ton);
      if (!Number.isFinite(amountTon) || amountTon <= 0) throw new Error('bad amount');
      if (amountTon < MIN_WITHDRAW_TON) throw new Error(`Минимальный вывод: ${MIN_WITHDRAW_TON} TON`);

      const amountNano = tonToNanoBig(amountTon);

      // balance check + hold in transaction
      const id = `w_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      const now = Date.now();

      await ensureUser(s.address);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const balR = await client.query(
          `SELECT COALESCE(SUM(delta_nano),0)::bigint AS bal FROM ledger WHERE address=$1`,
          [s.address]
        );
        const bal = BigInt(balR.rows[0].bal);
        if (bal < amountNano) throw new Error('Недостаточно средств');

        const status = amountTon <= AUTO_PAYOUT_MAX_TON ? 'processing' : 'pending';

        await client.query(
          `INSERT INTO withdrawals(id,address,to_address,amount_nano,status,created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, s.address, to, amountNano.toString(), status, now]
        );

        // hold funds
        await client.query(
          `INSERT INTO ledger(address, delta_nano, reason, ref, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [s.address, (-amountNano).toString(), 'withdraw_hold', id, now]
        );

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      // auto payout
      if (amountTon <= AUTO_PAYOUT_MAX_TON) {
        if (DISABLE_PAYOUTS) {
          await pool.query(
            `UPDATE withdrawals SET status='pending', note=$1 WHERE id=$2`,
            ['DISABLE_PAYOUTS=1 (dry-run)', id]
          );
          return res.json({ ok: true, id, status: 'pending', note: 'dry-run' });
        }

        try {
          const tx = await sendTon({ to, amountTon });
          await pool.query(
            `UPDATE withdrawals SET status='paid', decided_at=$1, note=$2 WHERE id=$3`,
            [Date.now(), `tx=${tx}`, id]
          );
          return res.json({ ok: true, id, status: 'paid', tx });
        } catch (e) {
          // release hold on failure
          await addLedger(s.address, amountNano, 'withdraw_release', id);
          await pool.query(
            `UPDATE withdrawals SET status='failed', decided_at=$1, note=$2 WHERE id=$3`,
            [Date.now(), `error=${e.message || String(e)}`, id]
          );
          return res.json({ ok: false, id, status: 'failed', error: e.message || String(e) });
        }
      }

      res.json({ ok: true, id, status: 'pending' });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // admin list
  app.get('/api/admin/withdraw/list', async (req, res) => {
    try {
      mustAdmin(req);
      const r = await pool.query(
        `SELECT id,address,to_address,amount_nano,status,created_at,decided_at,note
         FROM withdrawals
         ORDER BY created_at DESC
         LIMIT 200`
      );
      res.json({ ok: true, withdrawals: r.rows });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // admin approve
  app.post('/api/admin/withdraw/approve', async (req, res) => {
    try {
      mustAdmin(req);
      const id = (req.body?.id || '').toString();
      if (!id) throw new Error('id required');

      const rowR = await pool.query(`SELECT * FROM withdrawals WHERE id=$1`, [id]);
      if (!rowR.rowCount) throw new Error('not found');
      const w = rowR.rows[0];
      if (w.status !== 'pending' && w.status !== 'processing') throw new Error('bad status');

      if ((process.env.DISABLE_PAYOUTS || '') === '1') {
        await pool.query(`UPDATE withdrawals SET note=$1 WHERE id=$2`, ['dry-run approve', id]);
        return res.json({ ok: true, id, status: w.status, note: 'dry-run' });
      }

      const amountTon = Number(BigInt(w.amount_nano) / 1000000000n) + 0; // just for sendTon
      // better: sendTon should accept nano, but keep as TON for now:
      const tx = await sendTon({ to: w.to_address, amountTon: Number(w.amount_nano) / 1e9 });

      await pool.query(
        `UPDATE withdrawals SET status='paid', decided_at=$1, note=$2 WHERE id=$3`,
        [Date.now(), `tx=${tx}`, id]
      );
      res.json({ ok: true, id, status: 'paid', tx, amountTon });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
    }
  });

  // admin reject
  app.post('/api/admin/withdraw/reject', async (req, res) => {
    try {
      mustAdmin(req);
      const id = (req.body?.id || '').toString();
      if (!id) throw new Error('id required');

      const rowR = await pool.query(`SELECT * FROM withdrawals WHERE id=$1`, [id]);
      if (!rowR.rowCount) throw new Error('not found');
      const w = rowR.rows[0];
      if (w.status !== 'pending' && w.status !== 'processing') throw new Error('bad status');

      // release hold
      await addLedger(w.address, BigInt(w.amount_nano), 'withdraw_reject_release', id);

      await pool.query(
        `UPDATE withdrawals SET status='rejected', decided_at=$1, note=$2 WHERE id=$3`,
        [Date.now(), 'rejected by admin', id]
      );

      res.json({ ok: true, id, status: 'rejected' });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
    }
  });
}

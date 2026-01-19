// withdraw_routes.js — FINAL SAFE VERSION
// AUTO withdraw <= 3 TON
// MANUAL withdraw > 3 TON (Approve / Reject)
// SAFE approve: no money loss if sendTon fails

import crypto from 'crypto';
import { db, ensureUser, getBalanceNano, addLedger } from './db.js';
import { sendTon } from './payout.js';

const MIN_WITHDRAW_TON = Number(process.env.MIN_WITHDRAW_TON || '0.1');
const AUTO_MAX_TON = Number(process.env.AUTO_WITHDRAW_MAX_TON || '3');

// ===== helpers =====
function tonToNanoBig(ton) {
  const [a, b = ''] = String(ton).split('.');
  return BigInt(a) * 1_000_000_000n + BigInt((b + '000000000').slice(0, 9));
}

function mustAdmin(req) {
  const token =
    (req.query.token || '').trim() ||
    (req.headers['x-admin-token'] || '').trim() ||
    (req.headers.authorization || '').replace('Bearer ', '').trim();

  if (token !== (process.env.ADMIN_TOKEN || '').trim()) {
    const e = new Error('Unauthorized');
    e.status = 401;
    throw e;
  }
}

function jsonError(res, e) {
  res.status(e.status || 400).json({
    ok: false,
    error: e.message || String(e)
  });
}

function getSession(req) {
  const token =
    req.query.token ||
    req.headers['x-session-token'] ||
    (req.body && req.body.token) ||
    '';

  if (!token) return null;

  return db
    .prepare('SELECT token,address FROM sessions WHERE token=?')
    .get(token);
}

// ===== routes =====
export function registerWithdrawRoutes(app) {

  // =====================================================
  // CREATE WITHDRAW REQUEST (USER)
  // =====================================================
  app.post('/api/withdraw/request', async (req, res) => {
    try {
      const s = getSession(req);
      if (!s) throw new Error('no session');

      const to = req.body.to || req.body.to_address;
      const amountTon = Number(req.body.amountTon ?? req.body.amount_ton);

      if (!to) throw new Error('to required');
      if (!Number.isFinite(amountTon) || amountTon <= 0)
        throw new Error('bad amount');
      if (amountTon < MIN_WITHDRAW_TON)
        throw new Error(`min withdraw ${MIN_WITHDRAW_TON} TON`);

      const amountNano = tonToNanoBig(amountTon);
      if (getBalanceNano(s.address) < amountNano)
        throw new Error('insufficient balance');

      ensureUser(s.address);

      const id = 'w_' + crypto.randomBytes(8).toString('hex');
      const now = Date.now();

      // HOLD FUNDS
      addLedger(s.address, -amountNano, 'withdraw_hold', id);

      // =================================================
      // AUTO PAY
      // =================================================
      if (amountTon <= AUTO_MAX_TON) {
        try {
          const result = await sendTon({
            toAddress: to,
            amountNano
          });

          db.prepare(
            'INSERT INTO withdrawals(id,address,amount_nano,to_address,status,created_at,decided_at,note) VALUES (?,?,?,?,?,?,?,?)'
          ).run(
            id,
            s.address,
            Number(amountNano),
            to,
            'paid',
            now,
            now,
            result?.txid ? `auto tx:${result.txid}` : 'auto'
          );

          return res.json({
            ok: true,
            id,
            status: 'paid',
            mode: 'auto'
          });

        } catch (autoErr) {
          console.error('[AUTO PAY ERROR]', autoErr);

          // RELEASE HOLD BACK
          addLedger(s.address, amountNano, 'withdraw_release', id);

          db.prepare(
            'INSERT INTO withdrawals(id,address,amount_nano,to_address,status,created_at,decided_at,note) VALUES (?,?,?,?,?,?,?,?)'
          ).run(
            id,
            s.address,
            Number(amountNano),
            to,
            'failed',
            now,
            now,
            String(autoErr.message || autoErr)
          );

          return res.status(500).json({
            ok: false,
            error: 'auto withdraw failed',
            details: String(autoErr.message || autoErr)
          });
        }
      }

      // =================================================
      // MANUAL (ADMIN)
      // =================================================
      db.prepare(
        'INSERT INTO withdrawals(id,address,amount_nano,to_address,status,created_at) VALUES (?,?,?,?,?,?)'
      ).run(
        id,
        s.address,
        Number(amountNano),
        to,
        'pending',
        now
      );

      res.json({
        ok: true,
        id,
        status: 'pending',
        mode: 'manual'
      });

    } catch (e) {
      jsonError(res, e);
    }
  });

  // =====================================================
  // ADMIN LIST
  // =====================================================
  app.get('/api/admin/withdraw/list', (req, res) => {
    try {
      mustAdmin(req);
      const rows = db
        .prepare('SELECT * FROM withdrawals ORDER BY created_at DESC')
        .all();
      res.json({ ok: true, withdrawals: rows });
    } catch (e) {
      jsonError(res, e);
    }
  });

  // =====================================================
  // ADMIN APPROVE (SAFE)
  // =====================================================
  app.post('/api/admin/withdraw/approve', async (req, res) => {
    try {
      mustAdmin(req);

      const { id } = req.body || {};
      if (!id) throw new Error('id required');

      const w = db.prepare(
        'SELECT * FROM withdrawals WHERE id=?'
      ).get(id);

      if (!w) throw new Error('not found');
      if (w.status !== 'pending') throw new Error('not pending');

      try {
        const result = await sendTon({
          toAddress: w.to_address,
          amountNano: BigInt(w.amount_nano)
        });

        db.prepare(
          'UPDATE withdrawals SET status=?, decided_at=?, note=? WHERE id=?'
        ).run(
          'paid',
          Date.now(),
          result?.txid ? `tx:${result.txid}` : 'manual approve',
          id
        );

        res.json({ ok: true });

      } catch (sendErr) {
        console.error('[SEND TON ERROR]', sendErr);

        db.prepare(
          'UPDATE withdrawals SET status=?, decided_at=?, note=? WHERE id=?'
        ).run(
          'failed',
          Date.now(),
          String(sendErr.message || sendErr),
          id
        );

        res.status(500).json({
          ok: false,
          error: 'sendTon failed',
          details: String(sendErr.message || sendErr)
        });
      }

    } catch (e) {
      jsonError(res, e);
    }
  });

  // =====================================================
  // ADMIN REJECT
  // =====================================================
  app.post('/api/admin/withdraw/reject', (req, res) => {
    try {
      mustAdmin(req);

      const { id } = req.body || {};
      if (!id) throw new Error('id required');

      const w = db.prepare(
        'SELECT * FROM withdrawals WHERE id=?'
      ).get(id);

      if (!w || w.status !== 'pending')
        throw new Error('not pending');

      // RELEASE HOLD
      addLedger(
        w.address,
        BigInt(w.amount_nano),
        'withdraw_release',
        id
      );

      db.prepare(
        'UPDATE withdrawals SET status=?, decided_at=?, note=? WHERE id=?'
      ).run(
        'rejected',
        Date.now(),
        'rejected by admin',
        id
      );

      res.json({ ok: true });

    } catch (e) {
      jsonError(res, e);
    }
  });
}

// pg_migrate_from_sqlite.js
import { Pool } from 'pg';
import { db } from './db.js';

export async function migrateSqliteToPg() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing');

  const pool = new Pool({ connectionString: url });

  const tables = [
    { name: 'users', cols: ['address', 'created_at'] },
    { name: 'sessions', cols: ['token', 'address', 'created_at', 'last_seen'] },
    { name: 'deposits', cols: ['id', 'address', 'amount_nano', 'comment', 'status', 'tx_hash', 'created_at', 'confirmed_at'] },
    { name: 'withdrawals', cols: ['id', 'address', 'to_address', 'amount_nano', 'status', 'created_at', 'decided_at', 'note'] },
    { name: 'ledger', cols: ['address', 'delta_nano', 'reason', 'ref', 'created_at'] }, // id in PG is bigserial
    { name: 'game_runs', cols: ['id', 'address', 'bet_nano', 'status', 'started_at', 'finished_at', 'score', 'reward_nano'] },
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // small safety: avoid double-import by checking if PG already has users
    const already = await client.query('select count(*)::int as c from users');
    if (already.rows[0].c > 0) {
      throw new Error('Postgres already has data in users table. Refusing to migrate twice.');
    }

    for (const t of tables) {
      const rows = db.prepare(`SELECT ${t.cols.join(',')} FROM ${t.name}`).all();

      if (!rows.length) continue;

      const colList = t.cols.join(',');
      const placeholders = t.cols.map((_, i) => `$${i + 1}`).join(',');

      // use upsert to be safe for unique keys (except ledger)
      const conflict =
        t.name === 'ledger'
          ? ''
          : ` ON CONFLICT (${t.name === 'users' ? 'address' : 'id'}) DO NOTHING`;

      // sessions conflict key = token, deposits/withdrawals/game_runs conflict key = id
      const conflictKey =
        t.name === 'users' ? 'address' :
        t.name === 'sessions' ? 'token' :
        'id';

      const conflictClause =
        t.name === 'ledger' ? '' : ` ON CONFLICT (${conflictKey}) DO NOTHING`;

      const sql = `INSERT INTO ${t.name} (${colList}) VALUES (${placeholders})${conflictClause}`;

      for (const r of rows) {
        const values = t.cols.map(c => r[c]);
        await client.query(sql, values);
      }
    }

    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

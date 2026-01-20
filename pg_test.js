// pg_test.js
import { Pool } from 'pg';

export async function pgPing() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing');

  const pool = new Pool({
    connectionString: url,
    // Internal DB URL на Render обычно без SSL; если начнёт ругаться — включим ssl позже
  });

  try {
    const r = await pool.query('select now() as now');
    return r.rows[0].now;
  } finally {
    await pool.end();
  }
}

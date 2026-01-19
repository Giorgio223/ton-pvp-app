// apply_pg_schema.js
import fs from 'fs';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const sql = fs.readFileSync('./pg_schema.sql', 'utf8');

const pool = new Pool({
  connectionString: DATABASE_URL,
});

(async () => {
  try {
    console.log('[pg] applying schema...');
    await pool.query(sql);
    console.log('[pg] schema applied successfully');
    process.exit(0);
  } catch (e) {
    console.error('[pg] failed to apply schema:', e);
    process.exit(1);
  }
})();

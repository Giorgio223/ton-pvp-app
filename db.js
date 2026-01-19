import Database from 'better-sqlite3';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './db/app.sqlite';
fs.mkdirSync('db', { recursive: true });

export const db = new Database(DB_PATH);

try {
  db.pragma('journal_mode = WAL');
} catch {
  // ignore
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      address TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_address ON sessions(address);

    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      amount_nano INTEGER NOT NULL,
      comment TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      tx_hash TEXT,
      tx_lt TEXT,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_deposits_address ON deposits(address);

    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      amount_nano INTEGER NOT NULL,
      to_address TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_withdrawals_address ON withdrawals(address);

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      delta_nano INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_address ON ledger(address);

    -- Game runs (ставка 0.5 TON, начисление наград по score)
    CREATE TABLE IF NOT EXISTS game_runs (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      bet_nano INTEGER NOT NULL,
      status TEXT NOT NULL, -- started | finished
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      score INTEGER,
      reward_nano INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_game_runs_address ON game_runs(address);
  `);
}

export function ensureUser(address) {
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO users(address, created_at) VALUES (?, ?)').run(address, now);
}

export function getBalanceNano(address) {
  const row = db.prepare('SELECT COALESCE(SUM(delta_nano), 0) AS bal FROM ledger WHERE address = ?').get(address);
  return BigInt(row?.bal ?? 0);
}

export function addLedger(address, deltaNano, reason, ref = null) {
  const now = Date.now();
  db.prepare('INSERT INTO ledger(address, delta_nano, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(address, int64(deltaNano), reason, ref, now);
}

function int64(x) {
  // better-sqlite3 stores JS numbers as double; keep safe range.
  // For TON amounts we use nano: fits in 64-bit for typical ranges.
  if (typeof x === 'bigint') {
    const n = x;
    if (n > 9007199254740991n || n < -9007199254740991n) {
      throw new Error('Amount is too large for JS Number; adjust int handling');
    }
  }
  return Number(x);
}

-- pg_schema.sql
-- Schema for TON PVP app (Postgres)

CREATE TABLE IF NOT EXISTS users (
  address TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  amount_nano BIGINT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL,
  tx_hash TEXT,
  created_at BIGINT NOT NULL,
  confirmed_at BIGINT
);

CREATE INDEX IF NOT EXISTS deposits_address_idx ON deposits(address);
CREATE INDEX IF NOT EXISTS deposits_status_idx ON deposits(status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  to_address TEXT NOT NULL,
  amount_nano BIGINT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  decided_at BIGINT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS withdrawals_address_idx ON withdrawals(address);
CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals(status);

CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  address TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  delta_nano BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_address_idx ON ledger(address);
CREATE INDEX IF NOT EXISTS ledger_created_idx ON ledger(created_at);

CREATE TABLE IF NOT EXISTS game_runs (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES users(address) ON DELETE CASCADE,
  bet_nano BIGINT NOT NULL,
  status TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  score BIGINT,
  reward_nano BIGINT
);

CREATE INDEX IF NOT EXISTS game_runs_address_idx ON game_runs(address);

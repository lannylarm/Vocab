import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal URL (postgres.railway.internal) needs no SSL.
  // Set PGSSL=true only when connecting through the public proxy URL.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Tables are prefixed with vocab_ so they can share a Postgres instance with other apps.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS vocab_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocab_lookup_cache (
  query_key TEXT NOT NULL,
  source TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (query_key, source)
);

CREATE TABLE IF NOT EXISTS vocab_senses (
  id SERIAL PRIMARY KEY,
  profile_id INT NOT NULL REFERENCES vocab_profiles(id) ON DELETE CASCADE,
  headword TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  pos TEXT,
  definition TEXT NOT NULL,
  example TEXT,
  labels TEXT[] NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  variants JSONB NOT NULL DEFAULT '[]',
  distractors JSONB NOT NULL DEFAULT '[]',
  next_variant INT NOT NULL DEFAULT 0,
  level INT NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correct_count INT NOT NULL DEFAULT 0,
  wrong_count INT NOT NULL DEFAULT 0,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vocab_senses ADD COLUMN IF NOT EXISTS ipa_uk TEXT;
ALTER TABLE vocab_senses ADD COLUMN IF NOT EXISTS ipa_us TEXT;
ALTER TABLE vocab_senses ADD COLUMN IF NOT EXISTS audio_uk TEXT;
ALTER TABLE vocab_senses ADD COLUMN IF NOT EXISTS audio_us TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS vocab_senses_uniq
  ON vocab_senses (profile_id, lower(headword), md5(definition));
CREATE INDEX IF NOT EXISTS vocab_senses_due
  ON vocab_senses (profile_id, due_at);
`;

export async function initDb() {
  await pool.query(SCHEMA);
}

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

/** Return cached data for (query, source) or compute, store and return it. */
export async function cached(source, query, compute) {
  const key = query.toLowerCase();
  const r = await pool.query(
    'SELECT data, created_at FROM vocab_lookup_cache WHERE query_key=$1 AND source=$2',
    [key, source]
  );
  if (r.rows[0] && Date.now() - new Date(r.rows[0].created_at).getTime() < CACHE_TTL_MS) {
    return r.rows[0].data;
  }
  const data = await compute();
  await pool.query(
    `INSERT INTO vocab_lookup_cache (query_key, source, data) VALUES ($1,$2,$3)
     ON CONFLICT (query_key, source) DO UPDATE SET data=EXCLUDED.data, created_at=now()`,
    [key, source, JSON.stringify(data)]
  );
  return data;
}

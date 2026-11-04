-- Ampersand rooms at /ampersand: shared conversations and versioned pages for
-- invited browsers. Browser tokens and invites are stored only as hashes.
-- Timestamps are epoch milliseconds. A room's runner holds a lease, so one
-- function invocation works its queue at a time.
CREATE TABLE IF NOT EXISTS ampersand_rooms (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
  title text NOT NULL,
  review boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'error')),
  error text,
  version integer NOT NULL DEFAULT 1,
  processed_through integer NOT NULL DEFAULT 0,
  failed_through integer NOT NULL DEFAULT 0,
  runner text,
  runner_until double precision,
  cleanup_blocked boolean NOT NULL DEFAULT false,
  cleanup_owner text,
  cleanup_until double precision
);

-- Existing deployments may already have applied the initial rooms schema.
ALTER TABLE ampersand_rooms ADD COLUMN IF NOT EXISTS failed_through integer NOT NULL DEFAULT 0;
ALTER TABLE ampersand_rooms ADD COLUMN IF NOT EXISTS cleanup_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE ampersand_rooms ADD COLUMN IF NOT EXISTS cleanup_owner text;
ALTER TABLE ampersand_rooms ADD COLUMN IF NOT EXISTS cleanup_until double precision;

-- Short admission/cap batches lock this row before locking an individual room.
-- Separate statements after the lock get a fresh READ COMMITTED snapshot.
CREATE TABLE IF NOT EXISTS ampersand_coordination (
  id integer PRIMARY KEY CHECK (id = 1)
);
INSERT INTO ampersand_coordination (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ampersand_invites (
  room_id text NOT NULL REFERENCES ampersand_rooms(id) ON DELETE CASCADE,
  invite_hash text NOT NULL,
  PRIMARY KEY (room_id, invite_hash)
);

CREATE TABLE IF NOT EXISTS ampersand_members (
  seq serial,
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES ampersand_rooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL,
  joined_at double precision NOT NULL,
  UNIQUE (room_id, token_hash)
);
CREATE INDEX IF NOT EXISTS ampersand_members_token_idx ON ampersand_members(token_hash);

CREATE TABLE IF NOT EXISTS ampersand_messages (
  id serial PRIMARY KEY,
  room_id text NOT NULL REFERENCES ampersand_rooms(id) ON DELETE CASCADE,
  author_id text NOT NULL,
  author text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  text text NOT NULL,
  created_at double precision NOT NULL,
  request_id text,
  UNIQUE (room_id, author_id, request_id)
);
CREATE INDEX IF NOT EXISTS ampersand_messages_room_idx ON ampersand_messages(room_id, id);

CREATE TABLE IF NOT EXISTS ampersand_revisions (
  id serial PRIMARY KEY,
  room_id text NOT NULL REFERENCES ampersand_rooms(id) ON DELETE CASCADE,
  html text NOT NULL,
  created_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS ampersand_revisions_room_idx ON ampersand_revisions(room_id, id);

CREATE TABLE IF NOT EXISTS ampersand_activity (
  id serial PRIMARY KEY,
  room_id text NOT NULL REFERENCES ampersand_rooms(id) ON DELETE CASCADE,
  agent text NOT NULL CHECK (agent IN ('Builder', 'Reviewer')),
  kind text NOT NULL CHECK (kind IN ('message', 'publish', 'review')),
  text text NOT NULL,
  revision integer,
  created_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS ampersand_activity_room_idx ON ampersand_activity(room_id, id);

CREATE TABLE IF NOT EXISTS ampersand_sessions (
  room_id text NOT NULL REFERENCES ampersand_rooms(id) ON DELETE CASCADE,
  seat text NOT NULL CHECK (seat IN ('Builder', 'Reviewer')),
  session_id text NOT NULL,
  delivered_through integer NOT NULL,
  PRIMARY KEY (room_id, seat)
);

CREATE TABLE IF NOT EXISTS ampersand_usage (
  day text PRIMARY KEY,
  units integer NOT NULL
);

CREATE TABLE IF NOT EXISTS ampersand_hourly (
  key text NOT NULL,
  hour integer NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, hour)
);

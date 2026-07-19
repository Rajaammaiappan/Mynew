-- RUNVERSE migration 0001 — Phase 1 foundations
-- Requires: PostgreSQL 16, extensions postgis, h3 (h3-pg), pgcrypto, citext
-- Phase 2+ tables (economy, buildings, quests, clans, wars) land in later migrations;
-- columns referencing them here (owner_clan_id, season carry) are nullable by design.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
-- h3-pg: CREATE EXTENSION h3; (installed via package; required in prod, optional in dev —
-- Phase 1 computes H3 in the Node worker; h3-pg is used from Phase 2 rollups onward)

-- UUIDv7 (time-ordered) helper until pg18's native uuidv7()
CREATE OR REPLACE FUNCTION gen_uuidv7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid()) placing
        substring(int8send((extract(epoch from clock_timestamp())*1000)::bigint) from 3)
        from 1 for 6), 52, 1), 53, 1), 'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

-- ─── identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  handle          citext UNIQUE NOT NULL CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  email           citext UNIQUE,
  phone_e164      text UNIQUE,
  display_name    text NOT NULL,
  avatar_url      text,
  date_of_birth   date,
  home_cell_r5    bigint,
  color           text NOT NULL DEFAULT '#FF3B6B',    -- territory render color
  trust_score     smallint NOT NULL DEFAULT 100 CHECK (trust_score BETWEEN 0 AND 100),
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','shadow_banned','banned','deleted')),
  units           text NOT NULL DEFAULT 'metric' CHECK (units IN ('metric','imperial')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id                  uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('ios','android','dev')),
  model               text,
  os_version          text,
  push_token          text,
  attestation_verdict text CHECK (attestation_verdict IN ('pass','fail','unavailable')),
  mock_location_seen  boolean NOT NULL DEFAULT false,
  refresh_token_hash  text,
  last_seen_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices(user_id);

CREATE TABLE privacy_zones (
  id         uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      text NOT NULL DEFAULT 'home',
  center     geography(Point,4326) NOT NULL,
  radius_m   int NOT NULL CHECK (radius_m BETWEEN 100 AND 1500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX privacy_zones_gix ON privacy_zones USING gist(center);
CREATE INDEX privacy_zones_user_idx ON privacy_zones(user_id);

CREATE TABLE consent_ledger (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL,
  granted    boolean NOT NULL,
  version    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── seasons & territory ─────────────────────────────────────────────────────
CREATE TABLE seasons (
  id        smallserial PRIMARY KEY,
  name      text NOT NULL,
  theme     text,
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  status    text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','archived'))
);
INSERT INTO seasons(name, theme, starts_at, ends_at, status)
VALUES ('Season 1: First Blood', 'launch', now(), now() + interval '90 days', 'active');

CREATE TABLE hex_states (
  season_id         smallint NOT NULL REFERENCES seasons(id),
  h3_r9             bigint   NOT NULL,
  owner_user_id     uuid REFERENCES users(id),
  owner_clan_id     uuid,                          -- FK added with clans table (0003)
  strength          real NOT NULL DEFAULT 100 CHECK (strength BETWEEN 0 AND 100),
  captured_at       timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  capture_count     int NOT NULL DEFAULT 1,
  h3_r7             bigint NOT NULL,
  h3_r5             bigint NOT NULL,
  PRIMARY KEY (season_id, h3_r9)
);
CREATE INDEX hex_states_owner_idx ON hex_states(season_id, owner_user_id);
CREATE INDEX hex_states_r5_idx   ON hex_states(season_id, h3_r5);
CREATE INDEX hex_states_r7_idx   ON hex_states(season_id, h3_r7);

CREATE TABLE capture_events (
  id                 bigserial,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  season_id          smallint NOT NULL,
  h3_r9              bigint NOT NULL,
  activity_id        uuid,
  kind               text NOT NULL CHECK (kind IN
                     ('claim','steal','refresh','decay_loss','revoked','season_reset')),
  prev_owner_user_id uuid,
  prev_owner_clan_id uuid,
  new_owner_user_id  uuid,
  new_owner_clan_id  uuid,
  war_id             uuid,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
-- pg_partman manages monthly partitions in prod; bootstrap partitions for dev:
CREATE TABLE capture_events_default PARTITION OF capture_events DEFAULT;
CREATE INDEX capture_events_activity_idx ON capture_events(activity_id);
CREATE INDEX capture_events_owner_idx ON capture_events(new_owner_user_id, occurred_at DESC);

-- ─── activities ──────────────────────────────────────────────────────────────
CREATE TABLE activities (
  id                 uuid NOT NULL DEFAULT gen_uuidv7(),
  user_id            uuid NOT NULL REFERENCES users(id),
  type               text NOT NULL CHECK (type IN
                     ('run','walk','cycle','hike','trail_run','treadmill')),
  source             text NOT NULL DEFAULT 'live' CHECK (source IN
                     ('live','healthkit','health_connect','garmin','coros','suunto','polar',
                      'fitbit','wearos','apple_watch','import_gpx','import_fit','import_tcx')),
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  tz                 text NOT NULL DEFAULT 'Asia/Kolkata',
  distance_m         int NOT NULL DEFAULT 0 CHECK (distance_m >= 0),
  moving_time_s      int NOT NULL DEFAULT 0,
  elapsed_time_s     int NOT NULL DEFAULT 0,
  avg_pace_s_per_km  int,
  avg_hr             smallint,
  max_hr             smallint,
  avg_cadence_spm    smallint,
  elevation_gain_m   smallint,
  calories_kcal      smallint,
  splits             jsonb,
  polyline           text,
  geom               geography(LineString,4326),
  raw_stream_url     text,
  privacy_clipped    boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'recording' CHECK (status IN
                     ('recording','pending','validating','validated','rejected','flagged','abandoned')),
  pipeline_stage     text NOT NULL DEFAULT 'none' CHECK (pipeline_stage IN
                     ('none','validated','captured','rewarded','fanned_out')),
  validation_flags   jsonb NOT NULL DEFAULT '[]',
  vehicle_prob       real,
  season_id          smallint NOT NULL REFERENCES seasons(id),
  capture_budget     int,
  hexes_claimed      int NOT NULL DEFAULT 0,
  hexes_stolen       int NOT NULL DEFAULT 0,
  hexes_refreshed    int NOT NULL DEFAULT 0,
  visibility         text NOT NULL DEFAULT 'followers'
                     CHECK (visibility IN ('public','followers','private')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE TABLE activities_default PARTITION OF activities DEFAULT;
CREATE INDEX activities_user_idx ON activities(user_id, started_at DESC);
CREATE INDEX activities_pending_idx ON activities(status) WHERE status IN ('pending','flagged');

-- ─── social (Phase 1 basics) ─────────────────────────────────────────────────
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows(followee_id);

CREATE TABLE kudos (
  activity_id uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, user_id)
);

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  activity_id uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (char_length(body) <= 1000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX comments_activity_idx ON comments(activity_id, created_at);

-- ─── anti-cheat foundations ──────────────────────────────────────────────────
CREATE TABLE fraud_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  activity_id uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  flags       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','approved','rejected','shadow_banned')),
  reviewer_id uuid REFERENCES users(id),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX fraud_reviews_open_idx ON fraud_reviews(status) WHERE status = 'open';

CREATE TABLE trust_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      smallint NOT NULL,
  reason     text NOT NULL,
  ref_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

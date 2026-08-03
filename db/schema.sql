-- What the stores say about themselves. Applied with `make db`.
--
-- Long and narrow — one row per (day, source, store, metric) — rather than a column per metric.
-- Apple and Google expose different metric sets and both keep adding to them; a wide table would
-- need a migration for each, and this needs none. It also matches how the numbers are read: the
-- dashboard asks for one metric over a date range, never for all of them at once.
--
-- The primary key is the whole identity of a measurement, so writing is an UPSERT and re-running
-- a day is free. That is not a nicety: Apple RESTATES recent days, so the daily job re-fetches a
-- trailing window every time, and an append-only table would silently double every number in it.
CREATE TABLE IF NOT EXISTS store_daily (
  -- UTC, YYYY-MM-DD. The store's own day boundary, not ours — never recomputed from a timestamp.
  day      TEXT NOT NULL,
  -- The registry id, the same namespace as `source` on an event. This is what lets a landing
  -- visit and an install sit in one row of the dashboard without a join table.
  source   TEXT NOT NULL,
  store    TEXT NOT NULL CHECK (store IN ('appstore', 'play')),
  -- See METRICS in src/stores/schema.ts. Free text on purpose: a store adding a metric must not
  -- require a migration, and an unknown metric is better stored than dropped.
  metric   TEXT NOT NULL,
  -- The campaign token (`ct` on Apple, `utm_campaign` on Play), '' when the report is not broken
  -- down by campaign. Empty string rather than NULL so it can sit in the primary key: SQLite
  -- treats every NULL as distinct, which would let the same measurement be inserted forever.
  campaign TEXT NOT NULL DEFAULT '',
  country  TEXT NOT NULL DEFAULT '',
  value    REAL NOT NULL,
  -- When we fetched it. A restated number changes `value` and this; the day it describes does not.
  fetched  INTEGER NOT NULL,
  PRIMARY KEY (day, source, store, metric, campaign, country)
) WITHOUT ROWID;

-- The dashboard always asks "this source, this window", so that is the index. The primary key
-- already serves it left-to-right for day-first queries.
CREATE INDEX IF NOT EXISTS store_daily_source_day ON store_daily (source, day);

-- What the daily job has already done. Without it the job either re-fetches everything forever
-- or trusts a date computed from the clock — and the clock is right up until the day a run is
-- missed, which is the day the gap silently becomes permanent.
CREATE TABLE IF NOT EXISTS store_sync (
  store   TEXT NOT NULL,
  source  TEXT NOT NULL,
  -- The most recent day successfully fetched. The job starts from here minus the restatement
  -- window, never from "yesterday".
  through TEXT NOT NULL,
  ran     INTEGER NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (store, source)
) WITHOUT ROWID;

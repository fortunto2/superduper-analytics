-- What somebody else counted about us, one row per day: the stores, YouTube, and later the ad
-- networks. Applied with `make db`.
--
-- One table for all of them because the shape is identical — a day, one of our sources, who
-- reported it, what was measured, how much. Splitting per provider would mean a new table and a
-- new query for every channel, and the question that matters ("what did this campaign produce
-- across everything") would need a union of all of them.
--
-- Long and narrow — one row per (day, source, provider, metric) — rather than a column per
-- metric.
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
  -- Who reported it: 'appstore', 'play', 'youtube', later the ad networks. NO CHECK constraint,
  -- and that is a decision rather than an oversight: the list of providers is going to grow, and
  -- a CHECK over a growing list is a migration per channel to enforce something the code that
  -- writes here already knows. Same reasoning as `metric` being free text.
  provider TEXT NOT NULL,
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
  PRIMARY KEY (day, source, provider, metric, campaign, country)
) WITHOUT ROWID;

-- The dashboard always asks "this source, this window", so that is the index. The primary key
-- already serves it left-to-right for day-first queries.
CREATE INDEX IF NOT EXISTS store_daily_source_day ON store_daily (source, day);

-- What the daily job has already done. Without it the job either re-fetches everything forever
-- or trusts a date computed from the clock — and the clock is right up until the day a run is
-- missed, which is the day the gap silently becomes permanent.
CREATE TABLE IF NOT EXISTS store_sync (
  provider TEXT NOT NULL,
  source  TEXT NOT NULL,
  -- The most recent day successfully fetched. The job starts from here minus the restatement
  -- window, never from "yesterday".
  through TEXT NOT NULL,
  ran     INTEGER NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (provider, source)
) WITHOUT ROWID;

-- НАШИ суточные итоги, свёрнутые из Analytics Engine. Отдельная таблица от store_daily, и
-- разница принципиальная: там точные числа, которые никто не сэмплировал, здесь — взвешенные
-- оценки из сэмплированного хранилища, а `people` вдобавок нижняя граница. Сложить их в одну
-- таблицу значило бы потерять ровно то свойство, ради которого store_daily заведена.
--
-- Зачем: Analytics Engine удаляет через 90 дней. Свёртка стоит одну строку на продукт в сутки
-- на метрику — около четырёх тысяч в год — и переживает это на годы. Она отвечает на вопросы,
-- которые мы задаём СЕГОДНЯ (сколько людей, просмотров, вовлечённых у продукта в такой-то
-- день), и не отвечает на те, что придумаются завтра: сырых событий в ней нет, и разрез по
-- стране за март после удаления уже не построить. Полный архив — это по-прежнему Iceberg из
-- PRD §4; эта таблица закрывает дешёвую и главную его часть, а не отменяет его.
CREATE TABLE IF NOT EXISTS own_daily (
  day     TEXT NOT NULL,
  source  TEXT NOT NULL,
  platform TEXT NOT NULL,
  -- people | page_views | engaged | bot_events | events
  metric  TEXT NOT NULL,
  value   REAL NOT NULL,
  -- Было ли сэмплирование в этих сутках. Без флага `people` за старый день неотличимо от
  -- точного счёта, и через полгода никто уже не вспомнит, что это была нижняя граница.
  sampled INTEGER NOT NULL DEFAULT 0,
  rolled  INTEGER NOT NULL,
  PRIMARY KEY (day, source, platform, metric)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS own_daily_source_day ON own_daily (source, day);

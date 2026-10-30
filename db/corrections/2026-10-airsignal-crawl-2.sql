-- Air Signal web, 22/24/25/28 Oct 2026: the rollup recomputed per visitor instead of per day.
-- A visitor whose every row is ONE deep page (/<country>/<city>..., not /crew) with no referrer is
-- the crawler (Lightpanda/1.0, see docs/metrics.md); its events go to bot_events, everyone else
-- stays. 22 and 24 Oct had been removed whole by 2026-10-airsignal-crawl.sql, which also removed the
-- people from the Stanford hackathon on 24 Oct; 25 and 28 Oct were rolled up before the ingest fix.
-- Originals: 2026-10-airsignal-crawl-2.own_daily.json and .page_daily.json.
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-22','airsignal','web','people',2,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-22','airsignal','web','page_views',4,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-22','airsignal','web','engaged',3,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-22','airsignal','web','bot_events',81,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-22','airsignal','web','events',88,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
DELETE FROM page_daily WHERE day='2026-10-22' AND source='airsignal' AND provider='own';
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-22','airsignal','own','/',1,0,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-22','airsignal','own','/map',1,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-22','airsignal','own','/switzerland',1,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-22','airsignal','own','/switzerland/basse-nendaz',1,1,1793400000000);
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-24','airsignal','web','people',15,1,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-24','airsignal','web','page_views',59,1,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-24','airsignal','web','engaged',36,1,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-24','airsignal','web','bot_events',50,1,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-24','airsignal','web','events',145,1,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
DELETE FROM page_daily WHERE day='2026-10-24' AND source='airsignal' AND provider='own';
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/',4,6,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/api',3,0,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/costa-rica/san-francisco',3,0,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/countries',2,0,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/crew',30,22,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/crew/grid',4,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/crew/privacy',2,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/map',8,3,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/united-states/los-altos/station-19975',1,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/united-states/palo-alto',1,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-24','airsignal','own','/united-states/seaside-2',1,1,1793400000000);
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-25','airsignal','web','people',7,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-25','airsignal','web','page_views',10,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-25','airsignal','web','engaged',6,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-25','airsignal','web','bot_events',13,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-25','airsignal','web','events',29,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
DELETE FROM page_daily WHERE day='2026-10-25' AND source='airsignal' AND provider='own';
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-25','airsignal','own','/',3,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-25','airsignal','own','/crew',5,4,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-25','airsignal','own','/kuwait',1,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-25','airsignal','own','/map',1,0,1793400000000);
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-28','airsignal','web','people',1,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-28','airsignal','web','page_views',2,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-28','airsignal','web','engaged',2,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-28','airsignal','web','bot_events',53,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled) VALUES ('2026-10-28','airsignal','web','events',57,0,1793400000000) ON CONFLICT (day, source, platform, metric) DO UPDATE SET value = excluded.value, rolled = excluded.rolled;
DELETE FROM page_daily WHERE day='2026-10-28' AND source='airsignal' AND provider='own';
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-28','airsignal','own','/solomon-islands',1,1,1793400000000);
INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled) VALUES ('2026-10-28','airsignal','own','/solomon-islands/auki',1,1,1793400000000);

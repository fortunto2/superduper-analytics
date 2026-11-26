# Bot rows counted as people in ad-hoc SQL (rustman 2x, 26.11.2026)

Status: 1-3 done and deployed 26.11.2026 (version a043ea98) (1-2 in src/ingest.ts with tests; 3 in the analytics-dig skill and harness checks.json).

## What happened

The weekly `analytics-hypotheses` check reported rustman people-days 274 -> 558
(12-18 vs 19-25 Nov 2026). Measured in Analytics Engine:

| week | browser anon-days | bot anon-days | sum |
|---|---|---|---|
| 12-18 Nov | 117 | 157 | 274 |
| 19-25 Nov | 122 | 436 | 558 |

The check summed DISTINCT anon per day over ALL rows. `src/stats.ts` already excludes
`blob9 = 'bot'`; the ad-hoc query did not. Real people were flat (no-referrer anon 109 -> 118).

The growth is `meta-webindexer/1.1` (Meta AI search indexer), AS32934, US. Cloudflare zone
requests per day: 75-95 on 12-18 Nov, 170-235 on 19-24 Nov; distinct paths 15-31 -> 52-97.
It renders JS in Chrome 145, so it fires `page_viewed` and `page_engaged` (211 of 217), one
fresh anon per page, no referrer, 09-14 UTC. Our UA filter catches it only because its UA
URL contains `.../webmasters/crawler` (BOT_UA has `crawl`).

## Changes (in order)

1. **Name Meta's crawlers explicitly** — `src/ingest.ts`, BOT_UA: add
   `meta-webindexer|meta-externalagent|meta-externalads|facebookcatalog`. Today the match
   rides on a URL Meta can change. Test: the three UAs from `_work/rustman-2x/` classify `bot`,
   `Mozilla/5.0 ... Chrome/145 Safari/537.36` without the suffix stays `browser`.
2. **AS32934 as edge evidence, reason `crawler_asn`** — `edgeBotReason`: a separate small set
   `CRAWLER_ASNS = {32934 /* Meta */}`, not DATACENTER_ASNS (that list means clouds).
   Cost: Meta staff browsing from the corp network become bots; 14 days had 22 such
   `browser` rows across all sites, accepted. Yandex 13238 is NOT added: Yandex Browser users
   may sit on it; YandexBot is already caught by UA.
3. **Ad-hoc SQL guard** (the actual defect) — any people/page-view number in a report comes
   from `/v1/stats` or `seo traffic`, or the SQL carries `blob9 != 'bot'`. Add a `truth.ts`
   rule? No: truth reads D1, the defect is in agent-written SQL. Instead: rule in the
   `analytics-dig` skill (done 26.11) and the `analytics-hypotheses` check text says
   "people numbers from `seo traffic`, never hand SQL".

## Not doing

- No Cloudflare WAF/bot setting change: meta-webindexer reads the wiki for Meta AI answers,
  which is distribution, not abuse.

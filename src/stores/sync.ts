/**
 * The daily job: ask each store what happened, write it down.
 *
 * Runs on cron, and also on demand from `POST /v1/stores/sync` — because a job that can only be
 * observed by waiting until tomorrow is a job nobody can debug.
 */
import { APPS } from "../registry.generated";
import { ascToken, fetchSalesReport, parseSalesReport, rowsSalesWrites } from "./appstore";
import {
  DOWNLOADS_REPORT,
  fetchSegment,
  findOrCreateRequest,
  findReports,
  INSTALL_DELETION_REPORT,
  listInstances,
  parseDownloads,
  parseInstallDeletion,
  segmentUrls,
} from "./analytics-reports";
import type { StoreRow } from "./schema";
import { readSync, writeRows, writeSync } from "./db";
import { dayBefore, daysBetween, RESTATEMENT_DAYS, utcDay } from "./schema";

export type SyncResult = {
  provider: string;
  days: number;
  rows: number;
  skipped: number;
  from: string;
  to: string;
  notes: string[];
};

/**
 * How far back a first run reaches. Apple keeps daily sales reports for a rolling year or so;
 * pulling that on the very first run would be a hundred-odd requests in one invocation. Thirty
 * days is enough to see the current shape, and backfill is a deliberate act with an explicit
 * `?from=` rather than something that happens by surprise on a Tuesday.
 */
const FIRST_RUN_DAYS = 30;

/**
 * Apple's summary report covers the whole vendor account, so twelve apps cost one request per
 * day rather than twelve. The registry decides which of them we keep: an app in the account but
 * not in `registry/sources.yaml` is skipped, never invented as a new source.
 */
export async function syncAppStore(
  env: {
    STORES: D1Database;
    ASC_KEY_ID?: string;
    ASC_ISSUER_ID?: string;
    ASC_PRIVATE_KEY?: string;
    ASC_VENDOR_NUMBER?: string;
  },
  now: number,
  explicitFrom?: string,
): Promise<SyncResult> {
  const notes: string[] = [];
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_VENDOR_NUMBER } = env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY || !ASC_VENDOR_NUMBER) {
    return {
      provider: "appstore",
      days: 0,
      rows: 0,
      skipped: 0,
      from: "",
      to: "",
      notes: ["not configured: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_VENDOR_NUMBER"],
    };
  }

  const storeIdToSource = new Map(
    APPS.filter((a) => a.platform === "ios").map((a) => [a.storeId, a.id as string]),
  );

  // Yesterday, not today: today's report does not exist yet, and asking for it is a 404 on every
  // single run — noise that teaches you to ignore the logs.
  const to = dayBefore(utcDay(now), 1);
  const previous = await readSync(env.STORES, "appstore");
  const furthest = [...previous.values()].sort().pop();
  const from =
    explicitFrom ??
    (furthest === undefined
      ? dayBefore(to, FIRST_RUN_DAYS)
      : // Back up over the restatement window: the last few days we already have are not final.
        dayBefore(furthest, RESTATEMENT_DAYS));

  const token = await ascToken(ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, now);
  const days = daysBetween(from, to);

  let rows = 0;
  let skipped = 0;
  let lastGood = "";
  for (const day of days) {
    let tsv: string | null;
    try {
      tsv = await fetchSalesReport({ token, vendorNumber: ASC_VENDOR_NUMBER, day });
    } catch (error) {
      // One bad day must not lose the days after it. Recorded and carried past, because the
      // alternative — stopping — means a single transient 500 freezes the watermark forever.
      notes.push(`${day}: ${String(error)}`);
      continue;
    }
    // 404 is the honest answer for a day with no sales at all. Nothing to write, and the
    // watermark still advances — otherwise a quiet week would make the job re-ask forever.
    if (tsv !== null) {
      const parsed = parseSalesReport(tsv, storeIdToSource);
      rows += await writeRows(env.STORES, rowsSalesWrites(parsed.rows), now);
      skipped += parsed.skipped;
    }
    lastGood = day;
  }

  if (lastGood !== "") {
    // One watermark per source, all the same day: the report is per-vendor, so either every app
    // in it is current or none is.
    await writeSync(
      env.STORES,
      "appstore",
      new Map([...storeIdToSource.values()].map((id) => [id, lastGood])),
      now,
      notes.join("; ").slice(0, 500),
    );
  }

  return { provider: "appstore", days: days.length, rows, skipped, from, to, notes };
}

/**
 * Один отчёт App Analytics, который джоб забирает, и под каким водяным знаком. Знаки разные
 * не из аккуратности: отчёты готовятся независимо, и один, отставший на сутки, не должен
 * тянуть назад второй или заставлять его перечитывать то, что уже записано.
 */
type ReportPass = {
  provider: string;
  report: string;
  parse: (tsv: string, source: string) => { rows: StoreRow[]; skipped: number };
};

/**
 * Загрузки первыми: это установки, главное число, и если бюджет подзапросов кончится на
 * середине, пусть его не хватит удалениям, а не им. Первый прогон прохода без водяного знака
 * забирает всё, что Apple ещё хранит (около месяца) — это и есть бэкфилл.
 */
const PASSES: readonly ReportPass[] = [
  { provider: "appstore-downloads", report: DOWNLOADS_REPORT, parse: parseDownloads },
  { provider: "appstore-analytics", report: INSTALL_DELETION_REPORT, parse: parseInstallDeletion },
];

/**
 * Установки и переустановки (`App Downloads Standard`) и УДАЛЕНИЯ (`Installation and Deletion`)
 * из App Analytics — по приложению, а не по вендору. Почему установки не из второго отчёта, хотя
 * они там есть, — см. `parseInstallDeletion`.
 *
 * Отдельный джоб от `syncAppStore`, и не из аккуратности: у отчётов другой API (асинхронный,
 * четыре шага вместо одного), другая единица работы (приложение, а не весь аккаунт), другой
 * ключ доступа (`ASC_VENDOR_NUMBER` здесь не нужен вовсе) и другая частота готовности. Слитый
 * воедино, он падал бы целиком из-за любой половины.
 *
 * Водяной знак — на приложение и на отчёт: у каждого свой запрос и свои инстансы, и одно
 * приложение, отставшее на сутки, не должно тянуть назад остальные.
 */
export async function syncStoreAnalytics(
  env: { STORES: D1Database; ASC_KEY_ID?: string; ASC_ISSUER_ID?: string; ASC_PRIVATE_KEY?: string },
  now: number,
): Promise<SyncResult[]> {
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY } = env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY) {
    return PASSES.map((p) => ({
      provider: p.provider,
      days: 0,
      rows: 0,
      skipped: 0,
      from: "",
      to: "",
      notes: ["not configured: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY"],
    }));
  }

  const token = await ascToken(ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, now);
  const passes = await Promise.all(
    PASSES.map(async (pass) => ({
      pass,
      previous: await readSync(env.STORES, pass.provider),
      through: new Map<string, string>(),
      result: { provider: pass.provider, days: 0, rows: 0, skipped: 0, from: "", to: "", notes: [] } as SyncResult,
    })),
  );
  // Android сюда не попадает: у Google своя консоль и свой формат. Приложение без номера в
  // App Store — тоже (у Play его нет), но сейчас такого среди ios нет, и тип это подтверждает.
  const apps = APPS.filter((a) => a.platform === "ios");

  for (const app of apps) {
    let reportIds: Map<string, string>;
    try {
      const requestId = await findOrCreateRequest(token, app.storeId);
      reportIds = await findReports(token, requestId, PASSES.map((p) => p.report));
    } catch (error) {
      // Одно приложение не должно уносить остальные: истёкший доступ или подвисший отчёт у
      // одного — это не причина не забрать данные по десяти другим.
      for (const { result } of passes) result.notes.push(`${app.id}: ${String(error)}`);
      continue;
    }

    for (const { pass, previous, through, result } of passes) {
      try {
        const reportId = reportIds.get(pass.report);
        if (reportId === undefined) {
          // Отчёта нет — обычное дело для приложения, у которого ещё не набралось данных. Это
          // факт про приложение, а не сбой джоба, поэтому записка и переход к следующему.
          result.notes.push(`${app.id}: no "${pass.report}" yet`);
          continue;
        }

        // Перечитываем последние сутки заново: Apple уточняет свежие дни, и UPSERT сводит копию
        // к правде вместо того, чтобы заморозить первое прочтение.
        const since = previous.get(app.id);
        const floor = since === undefined ? "" : dayBefore(since, RESTATEMENT_DAYS);
        const instances = (await listInstances(token, reportId))
          .filter((i) => i.day > floor)
          .sort((a, b) => a.day.localeCompare(b.day));

        for (const instance of instances) {
          for (const url of await segmentUrls(token, instance.id)) {
            const parsed = pass.parse(await fetchSegment(url), app.id);
            result.rows += await writeRows(env.STORES, parsed.rows, now);
            result.skipped += parsed.skipped;
          }
          result.days += 1;
          through.set(app.id, instance.day);
          if (result.from === "" || instance.day < result.from) result.from = instance.day;
          if (instance.day > result.to) result.to = instance.day;
        }
      } catch (error) {
        result.notes.push(`${app.id}: ${String(error)}`);
      }
    }
  }

  for (const { pass, through, result } of passes) {
    if (through.size > 0) await writeSync(env.STORES, pass.provider, through, now, result.notes.join("; ").slice(0, 500));
  }
  return passes.map((p) => p.result);
}

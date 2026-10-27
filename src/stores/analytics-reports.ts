/**
 * Отчёты App Analytics — установки, удаления и сессии, как их видит Apple.
 *
 * ЗАЧЕМ, при том что свой счётчик уже есть. Наш ретеншен отвечает «кто вернулся»: он видит
 * события и не видит тишину. Тишина двусмысленна — человек мог удалить приложение, а мог
 * положить телефон на неделю, и различить это изнутри нельзя ничем. Apple видит именно
 * УДАЛЕНИЕ, событием. Это то, чего у нас нет и не появится, сколько ни улучшай счётчик.
 *
 * Второе отличие: числа Apple точные. Они не сэмплированы (в отличие от Analytics Engine, где
 * `max_sample` у life2film уже дорос до двойки) и охватывают всех, включая тех, кто не открыл
 * приложение ни разу. Поэтому они ложатся в D1 рядом с продажами, а не в поток событий, и
 * ПО-ПРЕЖНЕМУ не складываются с нашими: «установки» Apple и «установки» ретеншена — разные
 * величины, вторая считает устройства, которые отчитались.
 *
 * API устроен в четыре шага, и это не прихоть: Apple готовит файлы асинхронно.
 *   запрос (на приложение, живёт долго) → отчёт (по имени) → инстанс (сутки) → сегменты (файлы)
 * Запрос создаётся один раз и потом переиспользуется; поэтому `findOrCreateRequest` сначала
 * ищет и только потом создаёт — иначе на каждом прогоне копился бы новый.
 */
import { METRICS, type StoreRow } from "./schema";

const ASC_API = "https://api.appstoreconnect.apple.com/v1";

/** Имя отчёта у Apple. Строка из их каталога — сверено по живому ответу, не по документации. */
export const INSTALL_DELETION_REPORT = "App Store Installation and Deletion Standard";

/**
 * `ONGOING` — Apple докладывает новые сутки сама, пока запрос жив. `ONE_TIME_SNAPSHOT` отдаёт
 * историю один раз и больше не обновляется, поэтому для суточного джоба он бесполезен.
 */
const ACCESS_TYPE = "ONGOING";

type Json = Record<string, unknown>;

async function ascGet(token: string, path: string): Promise<Json> {
  const response = await fetch(`${ASC_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`ASC ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as Json;
}

function dataArray(body: Json): Json[] {
  const data = body.data;
  return Array.isArray(data) ? (data as Json[]) : [];
}

function attrs(item: Json): Json {
  const a = item.attributes;
  return a !== null && typeof a === "object" ? (a as Json) : {};
}

/**
 * Идентификатор долгоживущего запроса для приложения.
 *
 * Ищем существующий `ONGOING` прежде, чем создавать: запросы не истекают, и джоб, создающий
 * новый каждые сутки, за месяц оставил бы тридцать, из которых работает первый.
 */
export async function findOrCreateRequest(token: string, appId: string): Promise<string> {
  const existing = dataArray(await ascGet(token, `/apps/${appId}/analyticsReportRequests?limit=50`));
  const ongoing = existing.find((r) => attrs(r).accessType === ACCESS_TYPE);
  if (ongoing !== undefined && typeof ongoing.id === "string") return ongoing.id;

  const response = await fetch(`${ASC_API}/analyticsReportRequests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType: ACCESS_TYPE },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`create report request for ${appId}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as Json;
  const id = (body.data as Json | undefined)?.id;
  if (typeof id !== "string") throw new Error(`create report request for ${appId}: no id in response`);
  return id;
}

/** Идентификатор отчёта по его имени. `undefined` — такого отчёта у этого приложения нет. */
export async function findReports(
  token: string,
  requestId: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  // Отчётов у одного запроса полторы сотни (framework usage, performance и прочее), поэтому
  // страница берётся большой, и все нужные имена ищутся в ОДНОМ ответе: два отчёта не повод
  // платить двумя обходами за каждое приложение.
  const reports = dataArray(await ascGet(token, `/analyticsReportRequests/${requestId}/reports?limit=200`));
  const found = new Map<string, string>();
  for (const r of reports) {
    const name = attrs(r).name;
    if (typeof name === "string" && names.includes(name) && typeof r.id === "string") found.set(name, r.id);
  }
  return found;
}

/** Один инстанс — это сутки (для DAILY). `processingDate` и есть день, который он описывает. */
export type ReportInstance = { id: string; day: string };

export async function listInstances(token: string, reportId: string): Promise<ReportInstance[]> {
  const items = dataArray(
    await ascGet(token, `/analyticsReports/${reportId}/instances?filter[granularity]=DAILY&limit=200`),
  );
  return items
    .map((i) => ({ id: String(i.id ?? ""), day: String(attrs(i).processingDate ?? "") }))
    .filter((i) => i.id !== "" && i.day !== "");
}

/**
 * Ссылки на файлы инстанса. Их может быть несколько: Apple режет большой день на сегменты, и
 * взять только первый — значит потерять часть суток, не заметив.
 */
export async function segmentUrls(token: string, instanceId: string): Promise<string[]> {
  const items = dataArray(await ascGet(token, `/analyticsReportInstances/${instanceId}/segments?limit=50`));
  return items.map((s) => String(attrs(s).url ?? "")).filter((u) => u !== "");
}

/**
 * Сегмент — gzip поверх TSV. Ссылка уже подписана, второй раз авторизоваться нечем и не нужно;
 * добавленный сюда заголовок Authorization ломает подпись на стороне хранилища.
 */
export async function fetchSegment(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`segment: ${response.status}`);
  const stream = response.body?.pipeThrough(new DecompressionStream("gzip"));
  if (stream === undefined) return "";
  return await new Response(stream).text();
}

/** Имя второго отчёта: установки и переустановки. См. `parseDownloads`. */
export const DOWNLOADS_REPORT = "App Downloads Standard";

/**
 * Что значит строка отчёта: метрика, `null` — строка известная, но не наша, `undefined` —
 * незнакомая (её считаем в `skipped`, чтобы новый тип у Apple был виден, а не проглочен).
 */
type Classify = (cell: (name: string) => string) => string | null | undefined;

/**
 * Общий разбор обоих отчётов: TSV → суммы по (день, метрика, страна).
 *
 * Колонки читаются ПО ИМЕНИ, а не по позиции: Apple их дописывает, и жёсткий индекс однажды
 * начнёт означать соседнюю колонку молча. Ровно та же логика, что у блоб-слотов, только здесь
 * заголовок приходит вместе с данными и сверяться можно на каждом файле.
 *
 * Суммируем в памяти: один день одной страны приходит десятками строк, разбитых по устройству,
 * версии ОС и источнику перехода. Писать их по одной значило бы сто UPSERT-ов там, где хватит
 * трёх, и хранить в D1 разрезы, которых дашборд не спрашивает.
 */
function parseDaily(
  tsv: string,
  source: string,
  report: string,
  required: string[],
  classify: Classify,
): { rows: StoreRow[]; skipped: number } {
  const lines = tsv.split("\n").filter((l) => l.trim() !== "");
  const header = lines.shift();
  if (header === undefined) return { rows: [], skipped: 0 };

  const columns = header.split("\t").map((c) => c.trim());
  const missing = ["Date", "Counts", ...required].filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new Error(`unexpected columns in ${report}: no ${missing.join(", ")} in ${columns.slice(0, 6).join(", ")}`);
  }
  const iDay = columns.indexOf("Date");
  const iTerritory = columns.indexOf("Territory");
  const iCounts = columns.indexOf("Counts");

  const totals = new Map<string, StoreRow>();
  let skipped = 0;
  for (const line of lines) {
    const cells = line.split("\t");
    const cell = (name: string): string => {
      const i = columns.indexOf(name);
      return i === -1 ? "" : (cells[i] ?? "").trim();
    };
    const day = (cells[iDay] ?? "").trim();
    const country = iTerritory === -1 ? "" : (cells[iTerritory] ?? "").trim();
    const value = Number((cells[iCounts] ?? "").trim());
    if (day === "" || !Number.isFinite(value)) {
      skipped += 1;
      continue;
    }
    const metric = classify(cell);
    if (metric === null) continue;
    // Незнакомое пропускаем со счётом, а не роняем прогон: Apple добавит тип, и падать из-за
    // него было бы хуже, чем не знать про него сутки.
    if (metric === undefined) {
      skipped += 1;
      continue;
    }

    const key = `${day}|${metric}|${country}`;
    const seen = totals.get(key);
    if (seen === undefined) {
      totals.set(key, { day, source, provider: "appstore", metric, campaign: "", country, value });
    } else {
      seen.value += value;
    }
  }
  return { rows: [...totals.values()], skipped };
}

/**
 * Отчёт об установках и удалениях → только УДАЛЕНИЯ.
 *
 * Установки здесь тоже есть, но брать их отсюда нельзя по двум причинам, обе измерены на
 * life2film 2026-10-27. Первая: под `Install` Apple кладёт и обновления (`Manual update`,
 * `Auto-update`), и `Restore`, и `Auto-download` на второе устройство — выход 1.14 дал 151
 * «установку» за неделю. Вторая хуже: у отчёта лишнее измерение `App Download Date`, строки
 * мельче, и порог приватности выкидывает их целиком — 15 из 34 дневных файлов пустые, 75 первых
 * установок за месяц против ~74 за неделю в `App Downloads Standard`. Удалений же нет нигде,
 * кроме этого отчёта, и наш счётчик их не увидит никогда: тишина не отличает удалившего.
 */
export function parseInstallDeletion(tsv: string, source: string): { rows: StoreRow[]; skipped: number } {
  return parseDaily(tsv, source, INSTALL_DELETION_REPORT, ["Event"], (cell) => {
    const event = cell("Event");
    if (event === "Delete") return METRICS.deletes;
    if (event === "Install") return null;
    return undefined;
  });
}

/**
 * Отчёт о загрузках → установки и переустановки. Это тот же счёт, что App Store Connect
 * показывает как First-time downloads, поэтому числа на дашборде сходятся с их экраном.
 *
 * `Download Type` обязателен: без него установку не отличить от обновления, а обновлений после
 * каждого релиза в разы больше, чем новых людей.
 */
export function parseDownloads(tsv: string, source: string): { rows: StoreRow[]; skipped: number } {
  return parseDaily(tsv, source, DOWNLOADS_REPORT, ["Download Type"], (cell) => {
    switch (cell("Download Type")) {
      case "First-time download":
        return METRICS.installs;
      case "Redownload":
        return METRICS.redownloads;
      case "Manual update":
      case "Auto-update":
      case "Auto-download":
      case "Restore":
        return null;
      default:
        return undefined;
    }
  });
}

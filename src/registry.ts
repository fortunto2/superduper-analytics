/**
 * Who is allowed to report events. The list is generated from registry/sources.yaml at build
 * time — the Worker never parses YAML, and nothing at runtime can add a source. Registration
 * flows one way: git → generator → here.
 */
import { METRICS, SITES, SOURCE_IDS } from "./registry.generated";
import { DOUBLE_SLOTS } from "./schema";

/** Built once per isolate, not per request. */
const KNOWN = new Set<string>(SOURCE_IDS);

export function isKnownSource(id: string): boolean {
  return KNOWN.has(id);
}

/** Where each site actually lives. Built once per isolate, like the set above. */
const HOSTS = new Map<string, string>(SITES.map((s) => [s.id, s.host]));

/**
 * Is this event coming from where the registry says the source lives?
 *
 * The point is to stop counting ourselves building the thing. A beacon is a cross-origin POST,
 * so the browser attaches `Origin` at no cost to us, and anything that is not the registered
 * host is a local server, a preview deploy, or somebody else's copy of the tag — none of which
 * are visitors.
 *
 * FAILS OPEN, deliberately, in three places: no Origin (mobile apps, some privacy modes), a
 * source with no registered site (app-only ids), or an unparseable value. Dropping a real
 * visitor to be tidy is the worse error — the whole point of this project is that the numbers
 * are not quietly wrong.
 *
 * `www.` is accepted for the bare host and the other way round, because which one a site
 * redirects to is a hosting detail that changes without anybody thinking about analytics.
 */
export function isRegisteredOrigin(sourceId: string, origin: string | undefined): boolean {
  const expected = HOSTS.get(sourceId);
  if (expected === undefined || origin === undefined || origin === "" || origin === "null") {
    return true;
  }
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const bare = (h: string) => (h.startsWith("www.") ? h.slice(4) : h);
  return bare(host) === bare(expected.toLowerCase());
}

/**
 * Числовые размерности из реестра, в порядке позиций `double2..double20`.
 *
 * Зачем это существует. `metrics` на событии уезжают одним JSON в blob11, а у SQL Analytics
 * Engine нет функций для JSON — значит `avg(film_seconds)` не выражается никак, хотя число
 * лежит целым. Слот делает величину считаемой; JSON оставляет её читаемой построчно. Событие
 * пишет и туда и туда, и дублированием это не назвать: JSON переживёт добавление имени в
 * список задним числом, а слот даёт агрегат уже сегодня.
 *
 * Словарь ОБЩИЙ на все источники специально. Позиция, значащая у одного продукта одно, а у
 * другого другое, — тот же класс ошибки, что перестановка блобов, только заметить его труднее:
 * запрос без фильтра по `source` сложит разные величины и не сломается. Поэтому и имена
 * подбираются переиспользуемыми: `days_since_first` одинаково честен для серии снимков и для
 * подписки, а `photos_total` застрял бы на приложениях про фото.
 *
 * Слотов девятнадцать на всё и навсегда — Analytics Engine даёт двадцать doubles, один занят
 * временем события. Это не список «всех чисел, которые мы шлём», а список тех немногих, по
 * которым нужен агрегат В ГОРЯЧЕМ хранилище. Остальное живёт в JSON и дожидается архива.
 *
 * НОЛЬ В СЛОТЕ НЕОДНОЗНАЧЕН: и «прислали ноль», и «не прислали ничего» дают одно и то же —
 * doubles не имеют пустого значения. Восстановить разницу из них нельзя, поэтому агрегат
 * всегда сужается по имени события (`blob3`), а факт присутствия ключа проверяется по blob11:
 * он строка, и по ней работает LIKE.
 */
export const METRIC_SLOTS: readonly string[] = METRICS;

/**
 * Позиция метрики в doubles, считая от 1: `days_since_first` → 2, то есть `double2`.
 * `undefined` — имя без слота. Это не ошибка: число доедет в JSON и станет агрегируемым в тот
 * день, когда имя допишут в реестр.
 */
export function metricSlot(name: string): number | undefined {
  const at = METRIC_SLOTS.indexOf(name);
  return at === -1 ? undefined : DOUBLE_SLOTS.length + at + 1;
}

/**
 * Значения метрик по позициям слотов, для записи в sink. Длина — ровно по числу слотов.
 *
 * Отсутствующая метрика становится нулём: массив doubles позиционный, дырку в нём оставить
 * нечем. Это и есть та неоднозначность, о которой сказано выше, и она разрешается не здесь,
 * а в запросе — фильтром по имени события.
 */
export function metricDoubles(metrics: Record<string, number> | undefined): number[] {
  return METRIC_SLOTS.map((name) => metrics?.[name] ?? 0);
}

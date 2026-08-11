/**
 * Google Analytics 4 — чужой счётчик на тех же страницах.
 *
 * Наш счётчик и GA считают одно и то же разными способами: GA режут блокировщики, у нас
 * сэмплирование и свой фильтр ботов. Числа не совпадут и не должны — но пара, стоящая рядом,
 * отвечает на вопрос, на который ни одно из них не отвечает в одиночку: «нашему счётчику
 * вообще можно верить?». Неделя расхождения в единицы значит да; расхождение вдвое — повод
 * искать, что именно один из них не видит.
 *
 * Ходит крон, а не ноутбук. До этого строки GA попали в базу разовой выгрузкой, и цифра в
 * админке miralinka замерла на дне выгрузки — снаружи это выглядело как «трафик кончился».
 */
import { SITES } from "../registry.generated";

const API = "https://analyticsdata.googleapis.com/v1beta/properties";

/** Строка отчёта: одна страница одного сайта за сутки. */
export type GaRow = {
  day: string;
  source: string;
  path: string;
  page_views: number;
  engaged: number;
};

/**
 * Сайты, у которых в реестре указано свойство GA4.
 *
 * Хост здесь не для красоты: одно свойство обслуживает несколько сайтов, а кроме них видит
 * `localhost` и превью-развёртки `*.pages.dev`. У miralinka за месяц это 203 просмотра с
 * локальной машины против 630 боевых — треть выдуманного трафика, если хост не спрашивать.
 */
export function gaSites(): { id: string; host: string; property: string }[] {
  return SITES.filter((s) => !s.retired && s.ga !== "").map((s) => ({
    id: s.id,
    host: s.host,
    property: s.ga,
  }));
}

/**
 * Тело запроса к runReport. Отдельной функцией, потому что фильтр по хосту — это и есть
 * вся суть разделения сайтов, и проверять его надо без сети.
 *
 * `pagePath` — без строки запроса, как и путь у нашего счётчика: иначе одна страница
 * рассыпалась бы на десяток строк с utm-хвостами и не сошлась бы с нашей.
 */
export function gaReportBody(host: string, day: string, limit = 250): unknown {
  return {
    dateRanges: [{ startDate: day, endDate: day }],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }, { name: "engagedSessions" }],
    dimensionFilter: {
      filter: {
        fieldName: "hostName",
        stringFilter: { value: host, matchType: "EXACT" },
      },
    },
    limit,
  };
}

/** Ответ runReport → строки. Форма ответа позиционная: значения идут в порядке заказанных метрик. */
export function parseGaReport(
  body: { rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[] },
  siteId: string,
  day: string,
): GaRow[] {
  return (body.rows ?? [])
    .map((row) => ({
      day,
      source: siteId,
      path: row.dimensionValues?.[0]?.value ?? "",
      page_views: Number(row.metricValues?.[0]?.value ?? 0),
      engaged: Number(row.metricValues?.[1]?.value ?? 0),
    }))
    .filter((row) => row.path !== "");
}

/** Один день одного сайта. Ошибка — пустой список: сутки без GA не должны ронять весь джоб. */
export async function fetchGaDay(
  token: string,
  property: string,
  host: string,
  siteId: string,
  day: string,
): Promise<GaRow[]> {
  const response = await fetch(`${API}/${property}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(gaReportBody(host, day)),
  });
  if (!response.ok) return [];
  return parseGaReport(await response.json(), siteId, day);
}

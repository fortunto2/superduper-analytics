/**
 * Google Search Console — то, чего в этом проекте не хватало больше всего.
 *
 * Всё остальное здесь измеряет ПОСЛЕДСТВИЕ: человек уже пришёл, уже прочитал, уже установил.
 * Search Console измеряет причину — сколько раз нас показали в выдаче, по каким запросам и на
 * каком месте. Разница между показами и визитами это и есть весь доступный рост, и до сих пор
 * она лежала в CLI на одном ноутбуке: не в хранилище, не на панели, не в MCP, и исчезала с
 * закрытием терминала.
 *
 * Тянет крон, а не ноутбук. Сервисный аккаунт уже заведён и уже имеет доступ к ресурсам — тот
 * же, что у seo-cli; в воркер кладётся только его ключ.
 */
import { SITES } from "../registry.generated";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export type SearchEnv = {
  /** `…@….iam.gserviceaccount.com` сервисного аккаунта. */
  GOOGLE_SA_EMAIL?: string;
  /** Его приватный ключ в PEM. Секрет: `wrangler secret put GOOGLE_SA_KEY`. */
  GOOGLE_SA_KEY?: string;
};

/** Одна строка отчёта: запрос или страница за сутки. */
export type SearchRow = {
  day: string;
  site: string;
  /** `query` — по какому запросу показали, `page` — какую страницу. */
  kind: "query" | "page";
  key: string;
  clicks: number;
  impressions: number;
  /** Средняя позиция. Меньше — лучше; 1 это верх выдачи. */
  position: number;
};

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Токен доступа за сервисный аккаунт: подписанный JWT меняется на OAuth-токен.
 *
 * RS256, в отличие от ES256 у App Store Connect: у Google ключ RSA. Час жизни — и токен не
 * кэшируется между запросами намеренно, потому что крон ходит раз в сутки, и хранить его
 * дольше значило бы держать секрет там, где он не нужен.
 */
export async function googleToken(env: SearchEnv, now: number): Promise<string | undefined> {
  const { GOOGLE_SA_EMAIL, GOOGLE_SA_KEY } = env;
  if (!GOOGLE_SA_EMAIL || !GOOGLE_SA_KEY) return undefined;

  const der = Uint8Array.from(
    atob(GOOGLE_SA_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: GOOGLE_SA_EMAIL,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
  });
  if (!response.ok) return undefined;
  return (await response.json<{ access_token?: string }>()).access_token;
}

/**
 * Один день одного сайта, в двух разрезах.
 *
 * Search Console отдаёт данные с задержкой в два-три дня и потом ещё их уточняет, поэтому
 * суточный джоб перезабирает хвост, а запись идёт UPSERT'ом — как и у отчётов Apple, и по той
 * же причине: число, прочитанное первым, не окончательное.
 */
export async function fetchSearchDay(
  token: string,
  siteUrl: string,
  siteId: string,
  day: string,
  kind: "query" | "page",
  limit = 25,
): Promise<SearchRow[]> {
  // Домен передаётся как `sc-domain:` или как URL — здесь всегда URL, потому что именно так
  // ресурсы заведены в консоли у seo-cli, и расхождение дало бы пустой ответ вместо ошибки.
  const url = `${API}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      startDate: day,
      endDate: day,
      dimensions: [kind],
      rowLimit: limit,
      // Только веб-поиск: картинки и новости мешаются в позиции и отвечают на другой вопрос.
      type: "web",
    }),
  });
  if (!response.ok) return [];

  const body = await response.json<{
    rows?: { keys?: string[]; clicks?: number; impressions?: number; position?: number }[];
  }>();
  return (body.rows ?? []).map((row) => ({
    day,
    site: siteId,
    kind,
    key: row.keys?.[0] ?? "",
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    position: row.position ?? 0,
  }));
}

/** Сайты реестра, у которых есть, что спрашивать: живые и с адресом. */
export function searchableSites(): { id: string; url: string }[] {
  return SITES.filter((s) => !s.retired).map((s) => ({ id: s.id, url: s.url }));
}

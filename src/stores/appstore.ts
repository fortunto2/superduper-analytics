/**
 * Apple's Sales and Trends report → our rows.
 *
 * WHY THIS REPORT and not App Analytics. Sales and Trends is one synchronous GET that returns a
 * gzipped TSV for one day covering EVERY app under the vendor — twelve apps for one request.
 * App Analytics (impressions, product page views, the `ct` campaign breakdown) is a different,
 * asynchronous API: you register a standing report request, wait a day for Apple to generate
 * instances, then walk instances → segments → signed URLs. It is the right way to get the top of
 * the funnel and it is phase two; this file is the bottom of the funnel, which is where the money
 * is and which works the moment the key can read reports.
 *
 * Parsing is a pure function over the TSV text, so the whole mapping is tested from a fixture
 * with no network and no credentials — the same discipline as `cli replay` for events.
 */
import { METRICS, type StoreRow } from "./schema";

/** Apple's own host. Reports are not on the CDN and not on a per-account subdomain. */
const ASC_API = "https://api.appstoreconnect.apple.com/v1";

/**
 * What a row of the report counts, decided by its Product Type Identifier.
 *
 * The identifiers come in families: a leading `1` is a first-time download, `3` a re-download,
 * `7` an update, and the letter that follows says which device class (`1F` universal, `1T` iPad,
 * bare `1` iPhone, and so on). Matching the FAMILY rather than an exact list is deliberate —
 * Apple adds device classes, and a new `1V` should count as a download on the day it appears
 * rather than silently vanish from the totals.
 *
 * `IA…` is an in-app purchase; its units are not installs and must never be added to them.
 *
 * Verified against Apple's product type identifier reference: 1F free/paid universal app,
 * 3F re-download, 7F update, IA1 in-app purchase.
 */
function classify(productType: string): string | null {
  if (productType.startsWith("IA")) return METRICS.units;
  const family = productType[0];
  if (family === "1") return METRICS.installs;
  if (family === "3") return METRICS.redownloads;
  if (family === "7") return METRICS.updates;
  return null;
}

/** `MM/DD/YYYY`, which is what Apple puts in Begin Date, → `YYYY-MM-DD`. */
function isoDay(appleDate: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(appleDate.trim());
  return m === null ? null : `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * The report is a TSV whose first line is the header. Columns are addressed BY NAME, never by
 * position: Apple has added columns to this report more than once, and a positional reader turns
 * that into silently shifted data rather than an error.
 */
export function parseSalesReport(
  tsv: string,
  storeIdToSource: Map<string, string>,
): { rows: StoreRow[]; skipped: number } {
  const lines = tsv.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], skipped: 0 };

  const header = lines[0]!.split("\t").map((h) => h.trim());
  const at = (row: string[], name: string): string => {
    const i = header.indexOf(name);
    return i < 0 ? "" : (row[i] ?? "").trim();
  };

  // Several report lines collapse into one measurement — one per device class, one per currency.
  // Summing before writing keeps the primary key meaningful and the row count small.
  const totals = new Map<string, StoreRow>();
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const day = isoDay(at(cells, "Begin Date"));
    const source = storeIdToSource.get(at(cells, "Apple Identifier"));
    const metric = classify(at(cells, "Product Type Identifier"));

    // An app that is not in the registry is not an error: the vendor account holds apps this
    // project does not track. Counting it would invent a source id that nothing else knows.
    if (day === null || source === undefined || metric === null) {
      skipped += 1;
      continue;
    }

    const country = at(cells, "Country Code").toUpperCase();
    const units = Number(at(cells, "Units")) || 0;
    const proceeds = Number(at(cells, "Developer Proceeds")) || 0;
    // Developer Proceeds is in the Currency of Proceeds — EUR for a euro storefront, JPY for
    // Japan — not in dollars. This report carries no rate, so money that is not USD lands under
    // its own metric (`proceeds_eur`) instead of being added to dollars as if it were one.
    const currency = at(cells, "Currency of Proceeds").toLowerCase();
    const proceedsMetric =
      currency === "usd" ? METRICS.proceeds_usd : `proceeds_${currency || "unknown"}`;

    const add = (m: string, value: number) => {
      if (value === 0) return;
      const key = `${day}|${source}|${m}|${country}`;
      const found = totals.get(key);
      if (found === undefined) {
        totals.set(key, {
          day,
          source,
          provider: "appstore",
          metric: m,
          campaign: "",
          country,
          value,
        });
      } else {
        found.value += value;
      }
    };

    add(metric, units);
    // Proceeds are per unit in this report, so the line total is price × units. Recorded against
    // the day and country rather than the product type: "what did this app earn" is the question,
    // and splitting it by device class answers one nobody asks.
    if (proceeds !== 0) add(proceedsMetric, proceeds * units);
  }

  return { rows: [...totals.values()], skipped };
}

/**
 * Installs and re-downloads have ONE writer, and it is App Analytics (`App Downloads Standard`,
 * see sync.ts). This report lands them on the same key — day, app, `appstore`, metric, country —
 * and both jobs run in the same cron, so with two writers a row would hold whichever finished
 * last. The parser still classifies them (its tests pin what Apple's codes mean); the sync writes
 * only the rest: money, in-app units, updates.
 */
export function rowsSalesWrites(rows: StoreRow[]): StoreRow[] {
  return rows.filter((r) => r.metric !== METRICS.installs && r.metric !== METRICS.redownloads);
}

/**
 * A JWT for the App Store Connect API: ES256 over the .p8 private key, ten minutes, audience
 * `appstoreconnect-v1`. Signed with WebCrypto because a Worker has no Node crypto and no room
 * for a JWT library — this is thirty lines and one algorithm.
 */
export async function ascToken(
  keyId: string,
  issuerId: string,
  privateKeyPem: string,
  now: number,
): Promise<string> {
  const b64url = (data: ArrayBuffer | string): string => {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  // The .p8 arrives as PEM. Strip the armour and the newlines; what is left is base64 DER.
  const der = Uint8Array.from(
    atob(privateKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: issuerId,
      iat: Math.floor(now / 1000),
      // Apple rejects anything over 20 minutes. Ten leaves room for a slow clock either way.
      exp: Math.floor(now / 1000) + 600,
      aud: "appstoreconnect-v1",
    }),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${b64url(signature)}`;
}

export type SalesFetch = {
  token: string;
  vendorNumber: string;
  day: string;
};

/**
 * One day of the summary sales report, already un-gzipped.
 *
 * 404 means "Apple has no report for that day", which is the normal answer for today, for
 * yesterday before it is cut, and for any day with no activity at all. It is not a failure and
 * must not stop the run — returning null lets the caller carry on to the next day.
 */
export async function fetchSalesReport(f: SalesFetch): Promise<string | null> {
  const url = new URL(`${ASC_API}/salesReports`);
  url.searchParams.set("filter[frequency]", "DAILY");
  url.searchParams.set("filter[reportType]", "SALES");
  url.searchParams.set("filter[reportSubType]", "SUMMARY");
  url.searchParams.set("filter[vendorNumber]", f.vendorNumber);
  url.searchParams.set("filter[reportDate]", f.day);
  url.searchParams.set("filter[version]", "1_1");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${f.token}`, Accept: "application/a-gzip" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`App Store sales report ${f.day}: ${response.status} ${await response.text()}`);
  }

  // The body is gzip. DecompressionStream is in the runtime, so no library and no buffering of
  // a compressed blob we would only have to decompress anyway.
  const stream = response.body?.pipeThrough(new DecompressionStream("gzip"));
  if (stream === undefined) return null;
  return await new Response(stream).text();
}

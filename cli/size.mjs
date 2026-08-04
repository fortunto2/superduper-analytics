/**
 * Бюджет снипета — на том, что посетитель ДЕЙСТВИТЕЛЬНО скачивает.
 *
 * Cloudflare отдаёт brotli всем современным браузерам; gzip достаётся редким старым клиентам.
 * Тест внутри workerd мерить brotli не умеет — там есть только CompressionStream с gzip, — и
 * поэтому там стоит сторож от копипасты, а не бюджет. Настоящий бюджет здесь: он считает
 * brotli и запускается в `make check`, то есть до деплоя и без сети.
 */
import { brotliCompressSync, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const BROTLI_MAX = 1200;
const RAW_MAX = 2560;

const source = readFileSync(new URL("../src/snippet.ts", import.meta.url), "utf8");
const body = source.match(/export const SNIPPET = `([\s\S]*?)`;\n/)?.[1];
if (body === undefined) {
  console.error("snippet: не нашёл строку SNIPPET в src/snippet.ts");
  process.exit(1);
}

const bytes = Buffer.from(body, "utf8");
const brotli = brotliCompressSync(bytes).length;
const gzip = gzipSync(bytes).length;

console.log(`snippet: ${bytes.length} сырых, ${brotli} brotli, ${gzip} gzip`);

let bad = false;
if (brotli > BROTLI_MAX) {
  console.error(`  brotli ${brotli} > ${BROTLI_MAX} — это то, что скачивает посетитель`);
  bad = true;
}
if (bytes.length > RAW_MAX) {
  console.error(`  сырых ${bytes.length} > ${RAW_MAX} — сжатие прощает копипасту, счётчик нет`);
  bad = true;
}
process.exit(bad ? 1 : 0);

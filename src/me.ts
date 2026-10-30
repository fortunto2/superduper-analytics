/**
 * «Не считай меня»: ссылка с `?sda=off` на каждый живой сайт из реестра.
 *
 * Флаг живёт в localStorage САЙТА, а не здесь: хранилище у каждого origin своё, и страница на
 * analytics.superduperai.co не может поставить его за airsignal.app — ни напрямую, ни через
 * iframe (Chrome и Safari делят хранилище iframe по сайту верхнего уровня, и флаг лёг бы не туда).
 * Поэтому ссылки, а не кнопка «отключить везде»: один клик на сайт, в каждом браузере и профиле.
 *
 * Список берётся из реестра, а не пишется руками: новый сайт появляется здесь тем же коммитом,
 * которым появляется в реестре.
 */
import { SITES } from "./registry.generated";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function optOutPage(): string {
  const rows = SITES.filter((s) => !s.retired)
    .map(
      (s) =>
        `<li><a href="${esc(s.url)}/?sda=off" target="_blank" rel="noopener">${esc(s.host)}</a>` +
        ` <a class="on" href="${esc(s.url)}/?sda=on" target="_blank" rel="noopener">count me again</a></li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Don't count me</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--sub:#6e6e73;--link:#0066cc}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f5f5f7;--sub:#98989d;--link:#4da3ff}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:640px;padding:24px 16px}
p{color:var(--sub)}a{color:var(--link)}ul{padding-left:20px}li{margin:6px 0}.on{font-size:13px;color:var(--sub);margin-left:8px}
</style></head><body>
<h1>Don't count me</h1>
<p>Open each link once, in every browser and profile you use. The site shows "sda off" and from
then on your visits go out as automation: in the bots column, never in people. The flag lives in
that site's own storage, so clearing site data or a new browser counts you again. Sites without
the counter ignore the link.</p>
<ul>
${rows}
</ul>
</body></html>`;
}

/**
 * The open-startup page: a small, deliberate subset of the numbers, published without a key.
 *
 * Two rules make this safe to leave running:
 *
 *   1. Only sources with `public: true` in registry/sources.yaml appear. The flag is opt-in and
 *      defaults to false, so a product added later is private until someone decides otherwise.
 *      Publishing is a commit, and so is unpublishing.
 *   2. Nothing here reaches the private aggregate. `/v1/*` stays behind DASHBOARD_KEY; this
 *      endpoint builds its own answer from the published list and never sums across the rest.
 *
 * The numbers are OUR counter's, bot-filtered — and that reverses what this file used to argue.
 *
 * The old reasoning was that Cloudflare's edge counts uniques before sampling can drop rows, so
 * it is the more honest "how many people". Measurement killed it: on life2film the edge reported
 * twenty thousand uniques over a window in which two people had actually visited. It counts
 * every scraper, and on sites this size the scrapers are the overwhelming majority. Publishing
 * that under the word "visitors" on a page whose entire claim is honesty was the worst possible
 * place to keep the mistake — the private dashboard had already stopped believing it.
 *
 * A filtered undercount beats an unfiltered overcount, so: our own numbers, bots excluded,
 * marked as a lower bound whenever sampling was active. A published site with no counter shows
 * nothing rather than a number that is mostly robots.
 */
import { SITES } from "./registry.generated";
import { fetchStats, type StatsEnv } from "./stats";

/** How long the numbers may be stale. Nobody refreshes a public metrics page for a live figure. */
export const OPEN_CACHE_SECONDS = 900;

/**
 * The shell is cached far shorter than the data it renders. A deploy cannot reach a browser's
 * copy of the HTML, and a page that has outlived the shape of its own API renders as an empty
 * state — which reads as "this startup has no traffic".
 */
export const OPEN_PAGE_CACHE_SECONDS = 300;

/**
 * A ROW IS A DOMAIN, NOT A PRODUCT — and that is the whole correctness story here.
 *
 * Cloudflare measures per zone. `superduperai.co` and `live2play.superduperai.co` are one zone,
 * so there is exactly one number for both. Splitting it between them would be invention;
 * attaching it to whichever product sorted first would credit `live2play` with thirty thousand
 * visitors that are mostly not its own. Neither is acceptable on a page whose entire claim is
 * that the numbers are not massaged. So the domain is the row, and it names what it covers.
 */
export type OpenProduct = {
  id: string;
  url: string;
  /** People, bots excluded. A LOWER BOUND when `sampled` — see the note on the page. */
  people: number;
  page_views: number;
  /** Page views that saw a scroll, click or keypress. The hardest signal here to fake. */
  engaged: number;
};

export type OpenReport = {
  window_days: number;
  generated_at: string;
  /** Which counter produced these. Named so a reader never has to guess whose arithmetic it is. */
  source: "own-counter";
  /** True when Analytics Engine dropped rows in this window, which makes `people` a floor. */
  sampled: boolean;
  products: OpenProduct[];
};

export async function buildOpenReport(
  env: StatsEnv,
  days: number,
  now: number,
): Promise<OpenReport> {
  const published = SITES.filter((s) => s.open && !s.retired);
  const report: OpenReport = {
    window_days: days,
    generated_at: new Date(now).toISOString(),
    source: "own-counter",
    sampled: false,
    products: [],
  };
  if (published.length === 0) return report;

  const stats = await fetchStats(env, days);
  if (!stats.ok) return report;
  report.sampled = stats.stats.sampling_active;

  for (const site of published) {
    // Web only. An app shares the id with its site, and adding an install to a page view would
    // be the same category error this whole project keeps refusing to make.
    const rows = stats.stats.sources.filter(
      (row) => row.source === site.id && row.platform === "web",
    );
    if (rows.length === 0) continue;
    report.products.push({
      id: site.id,
      url: site.url,
      people: rows.reduce((sum, row) => sum + row.people_seen, 0),
      page_views: rows.reduce((sum, row) => sum + row.page_views, 0),
      engaged: rows.reduce((sum, row) => sum + row.engaged, 0),
    });
  }
  report.products.sort((a, b) => b.page_views - a.page_views);
  return report;
}

export const OPEN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open numbers · superduperai</title>
<meta name="description" content="Traffic for superduperai and its products, published automatically. Nobody types these in.">
<style>
:root{color-scheme:light;--plane:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;
  --muted:#898781;--grid:#e1e0d9;--border:rgba(11,11,11,.10);--series:#2a78d6}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;
  --plane:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--muted:#898781;
  --grid:#2c2c2a;--border:rgba(255,255,255,.10);--series:#3987e5}}
:root[data-theme="dark"]{color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;--ink:#fff;
  --ink-2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--border:rgba(255,255,255,.10);--series:#3987e5}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:64px 20px 80px}
h1{font-size:28px;font-weight:600;letter-spacing:-.02em;margin:0 0 10px}
.lede{color:var(--ink-2);margin:0 0 40px;font-size:17px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:8px 22px 18px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.04em;
  text-transform:uppercase;padding:14px 10px 10px 0;white-space:nowrap}
td{padding:14px 10px 14px 0;border-top:1px solid var(--grid)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.n{font-size:19px;font-weight:600;letter-spacing:-.01em}
a{color:var(--series);text-decoration:none}
a:hover{text-decoration:underline}
.sub{color:var(--muted);font-size:13px;font-weight:400}
.method{margin-top:36px;color:var(--ink-2);font-size:14px}
.method h2{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  color:var(--muted);margin:0 0 10px}
.method li{margin-bottom:7px}
footer{margin-top:36px;color:var(--muted);font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
</style>
</head><body><div class="wrap">
<h1>Open numbers</h1>
<p class="lede">Traffic for the products below, published automatically. Nobody types these in
and nobody can round them up — the page asks the same API the private dashboard does, and the
numbers are small on purpose: they are people, not requests.</p>
<div class="card"><div id="t">Loading…</div></div>

<div class="method">
  <h2>How these are counted</h2>
  <ul>
    <li><strong>These are our own counter's numbers, with bots excluded.</strong> This page used
      to publish Cloudflare's edge counts instead, on the theory that they lose nothing to
      sampling. They also count every scraper: on one of these domains the edge reported twenty
      thousand &ldquo;visitors&rdquo; over a window in which two people had actually visited. A
      filtered undercount beats an unfiltered overcount, especially on a page like this one.</li>
    <li><strong>People is a floor, not an estimate.</strong> Above a certain rate the store keeps
      a sample of rows, and a dropped row takes its anonymous id with it — no weighting brings
      back a value that was never written. Page views and engaged visits stay exact, because
      those are counts and counts can be weighted.</li>
    <li><strong>Engaged</strong> means a page view that saw a scroll, a click or a keypress.
      Loading a page is what a crawler does; interacting with it is what a person does.</li>
    <li>A product appears here only if <code>public: true</code> is set for it in
      <code>registry/sources.yaml</code>. That flag defaults to off, so nothing is published by
      forgetting.</li>
    <li>No cookies and no cross-site identifiers are involved anywhere in this stack.</li>
  </ul>
</div>

<footer>
  Built on <a href="https://github.com/fortunto2/superduper-analytics">superduper-analytics</a>,
  which is MIT and public — including the code that produced this page.
  <span id="gen"></span>
</footer>
</div>
<script>
var fmt=function(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e4?Math.round(n/1e3)+'k':n.toLocaleString('en-US')};
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
// cache:'no-cache' revalidates with the Worker instead of trusting the browser's copy. The
// browser cache is the one layer a deploy cannot reach: a shape change would otherwise render
// "nothing is published" to real visitors for the whole TTL. The Worker's own cache still
// absorbs the load, so the metered read budget is unaffected.
fetch('/open.json',{cache:'no-cache'}).then(function(r){return r.json()}).then(function(d){
  var el=document.getElementById('t');
  if(!d.products||!d.products.length){el.textContent='Nothing is published yet.';return}
  var h='<table><thead><tr><th>Product</th><th class="n">People</th><th class="n">Page views</th>'+
        '<th class="n">Engaged</th></tr></thead><tbody>';
  d.products.forEach(function(p){
    h+='<tr><td><a href="'+esc(p.url)+'">'+esc(p.id)+'</a>'+
       '<div class="sub">'+esc(p.url.replace(/^https?:\/\//,''))+'</div></td>'+
       '<td class="n">'+fmt(p.people)+(d.sampled?'<span class="sub">+</span>':'')+'</td>'+
       '<td class="n">'+fmt(p.page_views)+'</td><td class="n">'+fmt(p.engaged)+'</td></tr>'});
  h+='</tbody></table><p class="sub" style="margin:14px 0 0">Last '+d.window_days+' days'+
     (d.sampled?'. \u201c+\u201d marks a lower bound: the store sampled this window.':'.')+'</p>';
  el.innerHTML=h;
  document.getElementById('gen').textContent='Updated '+new Date(d.generated_at).toUTCString()+'.';
}).catch(function(){document.getElementById('t').textContent='Numbers are temporarily unavailable.'});
</script>
</body></html>
`;

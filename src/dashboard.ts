/**
 * The dashboard. Worker-rendered, one self-contained page, no build step and no framework —
 * it reads /v1/overview and draws. PRD §8 chose this over pointing Grafana at the SQL API.
 *
 * The design follows the validated reference palette (blue slot 1 for the single trend series;
 * status colors for coverage, always paired with a word so meaning is never colour-alone).
 * Both themes are declared explicitly rather than flipped, and the viewer's toggle wins.
 *
 * THE ONE PANEL THAT MATTERS
 *
 * Coverage — Cloudflare's edge page views against our own. Our numbers alone cannot tell "this
 * site has no visitors" from "this site has no counter", and during a thirteen-site rollout
 * that is the only question worth answering. The two are shown side by side and never summed:
 * the edge counts HTTP requests including bots and assets, we count what a snippet reported.
 *
 * Unique people come from the edge, never from us. Analytics Engine samples, and a sampled-away
 * row takes its `anon` with it — our distinct count is a lower bound and says so.
 */

export const DASHBOARD_CACHE_SECONDS = 60;

export const DASHBOARD = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>superduper analytics</title><link rel="icon" href="/favicon.ico">
<style>
:root{
  color-scheme:light;
  --plane:#f9f9f7; --surface:#fcfcfb;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series:#2a78d6;
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  color-scheme:dark;
  --plane:#0d0d0d; --surface:#1a1a19;
  --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series:#3987e5;
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --plane:#0d0d0d; --surface:#1a1a19;
  --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series:#3987e5;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 72px}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:baseline;justify-content:space-between;margin-bottom:28px}
h1{font-size:19px;font-weight:600;margin:0;letter-spacing:-.01em}
h1 span{color:var(--muted);font-weight:400}
h2{font-size:13px;font-weight:600;margin:0 0 14px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.range{display:flex;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2px}
.range button{appearance:none;border:0;background:none;color:var(--ink-2);font:inherit;font-size:13px;
  padding:5px 11px;border-radius:6px;cursor:pointer}
.range button[aria-pressed=true]{background:var(--plane);color:var(--ink);font-weight:600}
.range button:hover{color:var(--ink)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin-bottom:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--border);
  border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px}
.tile{background:var(--surface);padding:18px 20px}
.tile .k{font-size:12px;color:var(--muted);margin-bottom:6px}
.tile .v{font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.tile.hero .v{font-size:48px}
.tile .s{font-size:12px;color:var(--muted);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:0 10px 8px 0;white-space:nowrap}
td{padding:9px 10px 9px 0;border-top:1px solid var(--grid);vertical-align:middle}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.name{font-weight:500}
.sub{color:var(--muted);font-size:12px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.note{font-size:13px;color:var(--ink-2);background:var(--surface);border:1px solid var(--border);
  border-left:3px solid var(--warn);border-radius:8px;padding:12px 14px;margin-bottom:20px}
.empty{color:var(--muted);font-size:14px;padding:8px 0}
svg{display:block;width:100%;height:200px;overflow:visible}
.tip{position:fixed;pointer-events:none;background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);opacity:0;transition:opacity .1s}
footer{color:var(--muted);font-size:12px;margin-top:28px;line-height:1.7}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
</style>
</head><body>
<div class="wrap">
  <header>
    <h1>superduper analytics <span id="win"></span></h1>
    <div class="range" role="group" aria-label="Time range">
      <button data-d="1">24h</button><button data-d="7">7d</button>
      <button data-d="30">30d</button><button data-d="90">90d</button>
    </div>
  </header>
  <div id="app"><p class="empty">Loading…</p></div>
  <footer>
    Everything on the left is ours, counted weighted by <code>_sample_interval</code>, with
    anything classified <code>bot</code> excluded from people and page views and shown in its
    own column instead. Edge figures come from Cloudflare's zone analytics: they lose nothing to
    sampling but count every scraper, so they are an upper bound and are never added to ours.
    <br>Analytics Engine keeps 90 days. Anything older is an archive question.
  </footer>
</div>
<div class="tip" id="tip"></div>
<script>
var tip=document.getElementById('tip'),app=document.getElementById('app'),days=7;
var key=new URLSearchParams(location.search).get('k');
var fmt=function(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e4?Math.round(n/1e3)+'k':n.toLocaleString('en-US')};
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};

function tile(k,v,s,hero){return '<div class="tile'+(hero?' hero':'')+'"><div class="k">'+esc(k)+'</div>'+
  '<div class="v">'+esc(v)+'</div>'+(s?'<div class="s">'+esc(s)+'</div>':'')+'</div>'}

/**
 * Deliberately BINARY, not a percentage. Measured on life2film.com: 86% of what the edge
 * counts is curl and unidentified scrapers, and only ~12% is a real browser. A counter that
 * runs only in browsers can therefore never approach 100% of the edge figure, so a ratio
 * reads as failure when the counter is perfectly healthy. The question this panel exists to
 * answer is "is it reporting at all", and that question has three answers.
 */
function status(ours,edge){
  if(edge===0) return {c:'var(--muted)',t:'no edge data'};
  if(ours===0) return {c:'var(--crit)',t:'no counter'};
  return {c:'var(--good)',t:'reporting'};
}

function line(daily){
  if(daily.length<2) return '<p class="empty">Not enough days yet to draw a trend.</p>';
  var W=1000,H=200,P=28,max=Math.max.apply(null,daily.map(function(d){return d.events}))||1;
  var x=function(i){return P+i*(W-P*2)/(daily.length-1)},y=function(v){return H-P-(v/max)*(H-P*2)};
  var pts=daily.map(function(d,i){return x(i)+','+y(d.events)});
  var s='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="Events per day">';
  [0,.5,1].forEach(function(f){var yy=y(max*f);
    s+='<line x1="'+P+'" x2="'+(W-P)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--grid)" stroke-width="1"/>';
    s+='<text x="0" y="'+(yy+4)+'" fill="var(--muted)" font-size="11">'+fmt(Math.round(max*f))+'</text>'});
  s+='<polyline fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="'+pts.join(' ')+'"/>';
  daily.forEach(function(d,i){
    s+='<circle cx="'+x(i)+'" cy="'+y(d.events)+'" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>';
    s+='<rect x="'+(x(i)-14)+'" y="0" width="28" height="'+H+'" fill="transparent" data-d="'+esc(d.day)+'" data-v="'+d.events+'"/>'});
  s+='<text x="'+P+'" y="'+(H-6)+'" fill="var(--muted)" font-size="11">'+esc(daily[0].day)+'</text>';
  s+='<text x="'+(W-P)+'" y="'+(H-6)+'" fill="var(--muted)" font-size="11" text-anchor="end">'+esc(daily[daily.length-1].day)+'</text>';
  return s+'</svg>'
}

function render(o){
  var st=o.stats,edge=o.coverage.reduce(function(a,c){return a+c.edge_uniques},0);
  document.getElementById('win').textContent='· last '+st.window_days+(st.window_days===1?' day':' days');

  var h='';
  if(st.sampling_active) h+='<div class="note"><strong>Sampling is active.</strong> Event counts are '+
    'weighted and exact. “People” is a lower bound: a dropped row takes its anonymous id with '+
    'it, and no weighting brings back a value that was never written.</div>';

  // People come from OUR data, bot-filtered, not from the edge. The edge loses nothing to
  // sampling but counts every scraper: on life2film it reported 20k uniques where two people
  // had actually visited. A filtered undercount beats an unfiltered overcount.
  var botShare=st.total_events?Math.round(st.total_bot_events/st.total_events*100):0;
  h+='<div class="tiles">'+
    tile('People',fmt(st.total_people),'ours, bots excluded',true)+
    tile('Page views',fmt(st.total_page_views),'bots excluded')+
    tile('Engaged',fmt(st.total_engaged),'scrolled, clicked or typed')+
    tile('Bot events',fmt(st.total_bot_events),botShare+'% of everything received')+
    tile('Counters live',o.sites_reporting+' / '+o.sites_total,'registered sites')+
  '</div>';
  if(o.edge_available) h+='<p class="sub" style="margin:-8px 0 20px">Cloudflare\\u2019s edge saw '+
    fmt(edge)+' unique clients over the same window \\u2014 that figure loses nothing to sampling '+
    'but counts scrapers too, so it is an upper bound, not a second opinion.</p>';

  h+='<div class="card"><h2>Events per day</h2>'+line(st.daily)+'</div>';

  h+='<div class="card"><h2>Counter coverage</h2>';
  if(!o.edge_available) h+='<p class="empty">Cloudflare edge analytics unavailable — coverage cannot be judged.</p>';
  else if(!o.coverage.length) h+='<p class="empty">No registered site sits in a Cloudflare zone.</p>';
  else{
    h+='<table><thead><tr><th>Zone</th><th class="n">Edge, all traffic</th>'+
       '<th class="n">Ours, browsers</th><th>State</th></tr></thead><tbody>';
    o.coverage.forEach(function(c){var s=status(c.our_page_views,c.edge_page_views);
      h+='<tr><td><div class="name">'+esc(c.zone)+'</div><div class="sub">'+esc(c.sites.join(', '))+'</div></td>'+
        '<td class="n">'+fmt(c.edge_page_views)+'</td><td class="n">'+fmt(c.our_page_views)+'</td>'+
        '<td><span class="pill"><span class="dot" style="background:'+s.c+'"></span>'+esc(s.t)+'</span></td></tr>'});
    h+='</tbody></table>'+
      '<p class="sub" style="margin:12px 0 0">The two columns are different populations and '+
      'their ratio means nothing: on life2film.com 86% of what the edge counts is curl and '+
      'unidentified scrapers, against ~12% real browsers. Read this as installed or not '+
      'installed, and read the trend from our own column alone.</p>';
  }
  h+='</div>';

  if(o.agents&&o.agents.agents.length){
    var a=o.agents;
    h+='<div class="card"><h2>AI agents reading '+esc(a.zone)+'</h2>'+
      '<table><thead><tr><th>Agent</th><th>Operator</th><th>Why</th><th class="n">Requests</th></tr></thead><tbody>';
    a.agents.forEach(function(x){
      // An assistant fetching the page means a person asked something; a crawler means an
      // index is being built. Same traffic, opposite meaning.
      var why=x.category==='AI Assistant'?'answering someone':x.category==='AI Search'?'search result':'indexing';
      h+='<tr><td class="name">'+esc(x.agent)+'</td><td class="sub">'+esc(x.operator||'—')+'</td>'+
        '<td class="sub">'+esc(why)+'</td><td class="n">'+fmt(x.requests)+'</td></tr>'});
    h+='</tbody></table>';
    if(a.ai_paths.length) h+='<p class="sub" style="margin:14px 0 4px">What they read: '+
      a.ai_paths.slice(0,6).map(function(p){return esc(p.path)+' ('+p.requests+')'}).join(', ')+'</p>';
    h+='<p class="sub" style="margin:8px 0 0">Last 24 hours \u2014 the only window this dataset '+
      'allows on the free plan. Verified by Cloudflare against the agent\u2019s own IP ranges, so '+
      'a script cannot get listed here by calling itself ClaudeBot. These never reach our own '+
      'counter: they do not run JavaScript.</p></div>';
  }

  // Кампании: единственное место, где наша половина воронки сходится с чужой. Панель рисуется
  // только когда метка вообще встречалась — пустая таблица «кампаний нет» ничего не сообщает
  // тому, кто ни одной ещё не запускал, и просто занимает первый экран.
  if(st.campaigns&&st.campaigns.length){
    h+='<div class="card"><h2>Campaigns</h2>'+
      '<table><thead><tr><th>Campaign</th><th>Source</th><th>Where</th>'+
      '<th class="n">Visits</th><th class="n">Engaged</th><th class="n">Store clicks</th>'+
      '<th class="n">Bots</th></tr></thead><tbody>';
    st.campaigns.forEach(function(c){
      var chan=[c.utm_source,c.utm_medium].filter(Boolean).join(' / ')||'\u2014';
      h+='<tr><td class="name">'+esc(c.utm_campaign)+'</td><td class="sub">'+esc(chan)+'</td>'+
        '<td class="sub">'+esc(c.source)+'</td><td class="n">'+fmt(c.page_views)+'</td>'+
        '<td class="n">'+fmt(c.engaged)+'</td><td class="n">'+fmt(c.store_clicks)+'</td>'+
        '<td class="n'+(c.bot_views?' warn':'')+'">'+fmt(c.bot_views)+'</td></tr>'});
    h+='</tbody></table><p class="sub" style="margin:14px 0 0">Only visits carrying a '+
      '<code>utm_campaign</code> tag. A row with visits at zero and bots above it is not a broken '+
      'tag \u2014 it is a link that got scraped rather than clicked. Store clicks are our last '+
      'observable step: what happens after belongs to Apple, and joins back by this same tag '+
      'rather than by any identifier.</p></div>';
  }

  h+='<div class="card"><h2>Sources</h2>';
  if(!st.sources.length) h+='<p class="empty">No events in this window.</p>';
  else{
    h+='<table><thead><tr><th>Source</th><th>Platform</th><th class="n">People</th>'+
       '<th class="n">Page views</th><th class="n">Engaged</th><th class="n">Bot events</th></tr></thead><tbody>';
    // Источники приходят уже сгруппированными по домену. Показываем домен один раз на
    // группу: повторять его в каждой строке — шум, а не структура.
    var lastDomain=null;
    st.sources.forEach(function(r){
      var mostly=r.events>0&&r.bot_events/r.events>0.5;
      if(r.domain&&r.domain!==lastDomain){
        lastDomain=r.domain;
        h+='<tr><td colspan="5" class="sub" style="padding-top:14px;border-top:1px solid var(--grid)">'+
          esc(r.domain)+'</td></tr>';
      }
      h+='<tr><td class="name" style="padding-left:12px">'+esc(r.source)+'</td><td class="sub">'+esc(r.platform)+'</td>'+
        '<td class="n">'+fmt(r.people_seen)+(r.max_sample>1?' <span class="sub">+</span>':'')+'</td>'+
        '<td class="n">'+fmt(r.page_views)+'</td>'+
        '<td class="n">'+fmt(r.engaged)+'</td>'+
        '<td class="n"'+(mostly?' style="color:var(--warn)"':'')+'>'+fmt(r.bot_events)+'</td></tr>'});
    h+='</tbody></table>';
    if(st.sources.some(function(r){return r.max_sample>1}))
      h+='<p class="sub" style="margin:10px 0 0">“+” marks a lower bound: sampling dropped rows in that group.</p>';
  }
  h+='</div>';
  app.innerHTML=h;
}

app.addEventListener('mouseover',function(e){
  var r=e.target.closest('rect[data-d]');if(!r)return;
  tip.innerHTML='<strong>'+esc(r.dataset.d)+'</strong><br>'+fmt(+r.dataset.v)+' events';
  tip.style.opacity=1});
app.addEventListener('mousemove',function(e){
  tip.style.left=Math.min(e.clientX+14,innerWidth-160)+'px';tip.style.top=(e.clientY+14)+'px'});
app.addEventListener('mouseout',function(e){if(e.target.closest('rect[data-d]'))tip.style.opacity=0});

function load(){
  document.querySelectorAll('.range button').forEach(function(b){
    b.setAttribute('aria-pressed',String(+b.dataset.d===days))});
  fetch('/v1/overview?days='+days+(key?'&k='+encodeURIComponent(key):''))
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){x.ok?render(x.j):app.innerHTML='<div class="note"><strong>'+esc(x.j.error||'error')+
      '</strong><br>'+esc(x.j.message||'')+'</div>'})
    .catch(function(){app.innerHTML='<p class="empty">Could not reach the API.</p>'})
}
document.querySelector('.range').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;days=+b.dataset.d;load()});
load();
</script>
</body></html>
`;

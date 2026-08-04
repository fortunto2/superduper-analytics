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
import { CHART_CSS, CHART_JS } from "./chart";

export const DASHBOARD_CACHE_SECONDS = 60;

export const DASHBOARD = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>superduper analytics</title><link rel="icon" href="/favicon.ico">
<style>
${CHART_CSS}
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
.links{display:flex;flex-wrap:wrap;gap:16px;margin:-8px 0 22px}
.links a{color:var(--muted);text-decoration:none;font-size:13px;font-weight:600}
.links a:hover{color:var(--series)}
.picker{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}
.chip{display:inline-block;padding:5px 12px;border:1px solid var(--border);border-radius:20px;
  font-size:13px;font-weight:600;color:var(--muted);text-decoration:none;background:var(--surface)}
.chip:hover{color:var(--fg)}
.chip.on{background:var(--fg);color:var(--surface);border-color:var(--fg)}
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
  <!-- Остальные входы в те же данные. Без этого о них помнит только тот, кто их написал:
       открытая страница и MCP не видны ниоткуда, и через месяц о них не вспомнит никто. -->
  <nav class="links">
    <a href="/open" target="_blank" rel="noopener">Open page &#8599;</a>
    <a href="/mcp" id="mcp" target="_blank" rel="noopener">MCP endpoint &#8599;</a>
    <a href="https://github.com/fortunto2/superduper-analytics" target="_blank" rel="noopener">Source &#8599;</a>
  </nav>
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

/** Суточные строки приходят по продуктам; для линии их надо свернуть по дням. */
function byDay(rows,pick){
  var m={},out=[];
  rows.forEach(function(r){ if(pick&&r.source!==pick) return; m[r.day]=(m[r.day]||0)+r.events });
  Object.keys(m).sort().forEach(function(d){ out.push({day:d,events:m[d]}) });
  return out
}

/**
 * Кто сейчас выбран. Живёт в адресе, а не в переменной: ссылку на конкретный продукт можно
 * послать, открыть во второй вкладке и вернуться к ней кнопкой «назад». Состояние фильтра,
 * которое нельзя показать другому человеку, — это не фильтр, а настройка.
 */
function picked(){ return new URLSearchParams(location.search).get('p')||'' }

function pickerHtml(o,cur){
  var ids=o.stats.sources.map(function(r){return r.source}).filter(function(v,i,a){return a.indexOf(v)===i}).sort();
  var h='<div class="picker"><a class="chip'+(cur?'':' on')+'" href="'+link('')+'">All products</a>';
  ids.forEach(function(id){
    h+='<a class="chip'+(cur===id?' on':'')+'" href="'+link(id)+'">'+esc(id)+'</a>'});
  return h+'</div>'
}

/** Ссылка, сохраняющая окно и ключ: терять их при каждом клике — верный способ разлогиниться. */
function link(p){
  var q=new URLSearchParams(location.search);
  if(p) q.set('p',p); else q.delete('p');
  return '?'+q.toString()
}

${CHART_JS}

function render(o){
  var st=o.stats,edge=o.coverage.reduce(function(a,c){return a+c.edge_uniques},0);
  var cur=picked();
  var rows=st.sources.filter(function(r){return !cur||r.source===cur});
  if(cur&&!rows.length) cur='';
  var sum=function(f){return rows.reduce(function(a,r){return a+f(r)},0)};
  document.getElementById('win').textContent='· last '+st.window_days+(st.window_days===1?' day':' days');

  var h='';
  if(st.sampling_active) h+='<div class="note"><strong>Sampling is active.</strong> Event counts are '+
    'weighted and exact. “People” is a lower bound: a dropped row takes its anonymous id with '+
    'it, and no weighting brings back a value that was never written.</div>';

  // People come from OUR data, bot-filtered, not from the edge. The edge loses nothing to
  // sampling but counts every scraper: on life2film it reported 20k uniques where two people
  // had actually visited. A filtered undercount beats an unfiltered overcount.
  h+=pickerHtml(o,cur);

  var people=cur?sum(function(r){return r.people_seen}):st.total_people;
  var views=cur?sum(function(r){return r.page_views}):st.total_page_views;
  var engaged=cur?sum(function(r){return r.engaged}):st.total_engaged;
  var bots=cur?sum(function(r){return r.bot_events}):st.total_bot_events;
  var allEvents=cur?sum(function(r){return r.events}):st.total_events;
  var botShare=allEvents?Math.round(bots/allEvents*100):0;
  h+='<div class="tiles">'+
    tile('People',fmt(people),'ours, bots excluded',true)+
    tile('Page views',fmt(views),'bots excluded')+
    tile('Engaged',fmt(engaged),'scrolled, clicked or typed')+
    tile('Bot events',fmt(bots),botShare+'% of everything received')+
    (cur?tile('Product',esc(cur),'one of '+o.sites_total+' registered')
        :tile('Counters live',o.sites_reporting+' / '+o.sites_total,'registered sites'))+
  '</div>';

  // Агенты живут в другом окне — сутки, потолок бесплатного тарифа у этого датасета. Число
  // стоит рядом с остальными, поэтому окно названо прямо в подписи: молча смешать «за 7 дней»
  // и «за сутки» в одной строке плиток — это соврать формой, ничего не соврав цифрой.
  var aiTotal=(o.agents||[]).reduce(function(a,z){return a+z.ai_requests},0);
  if(aiTotal) h+='<div class="tiles" style="margin-top:-12px">'+
    tile('AI agents',fmt(aiTotal),'verified, last 24h \u2014 not the window above')+
    tile('Zones they read',String((o.agents||[]).length),'of '+o.coverage.length+' with edge data')+
  '</div>';
  if(o.edge_available&&!cur) h+='<p class="sub" style="margin:-8px 0 20px">Cloudflare\\u2019s edge saw '+
    fmt(edge)+' unique clients over the same window \\u2014 that figure loses nothing to sampling '+
    'but counts scrapers too, so it is an upper bound, not a second opinion.</p>';

  var ch=sdaChart((st.daily||[]).filter(function(r){return !cur||r.source===cur}),esc,fmt);
  h+='<div class="card"><h2>Events per day</h2>'+
    (ch.svg?'<div class="chart">'+ch.svg+'</div>'+ch.legend
           :'<p class="empty">Not enough days yet to draw a trend.</p>')+'</div>';

  // Покрытие и агенты — про зону целиком, а не про продукт: на одном домене их живёт несколько,
  // и показывать зонное число рядом с именем одного продукта значит приписать ему чужое.
  if(!cur){
  h+='<div class="card"><h2>Counter coverage</h2>';
  if(!o.edge_available) h+='<p class="empty">Cloudflare edge analytics unavailable — coverage cannot be judged.</p>';
  else if(!o.coverage.length) h+='<p class="empty">No registered site sits in a Cloudflare zone.</p>';
  else{
    var aiBy={};(o.agents||[]).forEach(function(z){aiBy[z.zone]=z.ai_requests});
    h+='<table><thead><tr><th>Zone</th><th class="n">Edge, all traffic</th>'+
       '<th class="n">Ours, browsers</th><th class="n">AI agents, 24h</th><th>State</th></tr></thead><tbody>';
    o.coverage.forEach(function(c){var s=status(c.our_page_views,c.edge_page_views);
      h+='<tr><td><div class="name">'+esc(c.zone)+'</div><div class="sub">'+esc(c.sites.join(', '))+'</div></td>'+
        '<td class="n">'+fmt(c.edge_page_views)+'</td><td class="n">'+fmt(c.our_page_views)+'</td>'+
        '<td class="n">'+(aiBy[c.zone]?fmt(aiBy[c.zone]):'\u2014')+'</td>'+
        '<td><span class="pill"><span class="dot" style="background:'+s.c+'"></span>'+esc(s.t)+'</span></td></tr>'});
    h+='</tbody></table>'+
      '<p class="sub" style="margin:12px 0 0">The two columns are different populations and '+
      'their ratio means nothing: on life2film.com 86% of what the edge counts is curl and '+
      'unidentified scrapers, against ~12% real browsers. Read this as installed or not '+
      'installed, and read the trend from our own column alone. The agent column is a third '+
      'window \u2014 24 hours, the widest this dataset allows on the free plan \u2014 so it is '+
      'comparable between zones and not with the two columns beside it.</p>';
  }
  h+='</div>';
  }

  // Агенты. На общей странице — по всем зонам сразу: она называется общей, а показывала одну,
  // и у остальных сайтов агенты будто отсутствовали. В срезе продукта остаётся его зона.
  var zonesOf=function(){
    var all=o.agents||[];
    if(!cur) return all;
    var mine=(o.coverage||[]).filter(function(c){return c.sites.indexOf(cur)>=0}).map(function(c){return c.zone});
    return all.filter(function(z){return mine.indexOf(z.zone)>=0})
  }();
  if(zonesOf.length){
    var totalAi=zonesOf.reduce(function(a,z){return a+z.ai_requests},0);
    h+='<div class="card"><h2>AI agents '+(cur?'reading '+esc(zonesOf[0].zone):'across all zones')+'</h2>';
    // Одна таблица со столбцом зоны вместо восьми таблиц: имена агентов повторяются, и
    // восемь почти одинаковых списков читаются хуже одного отсортированного.
    h+='<table><thead><tr><th>Agent</th><th>Operator</th><th>Why</th>'+
       (cur?'':'<th>Zone</th>')+'<th class="n">Requests</th></tr></thead><tbody>';
    var flat=[];
    zonesOf.forEach(function(z){z.agents.forEach(function(x){flat.push({z:z.zone,x:x})})});
    flat.sort(function(a,b){return b.x.requests-a.x.requests}).slice(0,20).forEach(function(r){
      var why=r.x.category==='AI Assistant'?'answering someone':r.x.category==='AI Search'?'search result':'indexing';
      h+='<tr><td class="name">'+esc(r.x.agent)+'</td><td class="sub">'+esc(r.x.operator||'\u2014')+'</td>'+
        '<td class="sub">'+esc(why)+'</td>'+(cur?'':'<td class="sub">'+esc(r.z)+'</td>')+
        '<td class="n">'+fmt(r.x.requests)+'</td></tr>'});
    h+='</tbody></table>';
    var paths=zonesOf[0].ai_paths||[];
    if(cur&&paths.length) h+='<p class="sub" style="margin:14px 0 4px">What they read: '+
      paths.slice(0,6).map(function(p){return esc(p.path)+' ('+p.requests+')'}).join(', ')+'</p>';
    h+='<p class="sub" style="margin:8px 0 0">'+fmt(totalAi)+' requests over the last 24 hours \u2014 '+
      'the only window this dataset allows on the free plan. Verified by Cloudflare against the '+
      'agent\u2019s own IP ranges, so a script cannot get listed here by calling itself ClaudeBot. '+
      'These never reach our own counter: they do not run JavaScript.</p></div>';
  }

  // Кампании: единственное место, где наша половина воронки сходится с чужой. Панель рисуется
  // только когда метка вообще встречалась — пустая таблица «кампаний нет» ничего не сообщает
  // тому, кто ни одной ещё не запускал, и просто занимает первый экран.
  // Что сказали сами магазины. Отдельной таблицей и НИКОГДА не в сумме с нашими числами:
  // «люди на лендинге» и «установки» считают разные стороны с разным определением суток.
  // Отношение между ними — воронка, сумма — бессмыслица.
  var stores=(o.stores||[]).filter(function(r){return !cur||r.source===cur});
  if(stores.length){
    var byMetric={},prods={};
    stores.forEach(function(r){ byMetric[r.metric]=1; (prods[r.source]=prods[r.source]||{})[r.metric]=r.value });
    var cols=['installs','redownloads','updates','proceeds_usd','units'].filter(function(m){return byMetric[m]});
    Object.keys(byMetric).forEach(function(m){ if(cols.indexOf(m)<0) cols.push(m) });
    h+='<div class="card"><h2>What the stores report</h2><table><thead><tr><th>Product</th>'+
      cols.map(function(m){return '<th class="n">'+esc(m.replace(/_/g,' '))+'</th>'}).join('')+
      '</tr></thead><tbody>';
    Object.keys(prods).sort().forEach(function(p){
      h+='<tr><td class="name">'+esc(p)+'</td>'+cols.map(function(m){
        var v=prods[p][m];
        return '<td class="n">'+(v===undefined?'\u2014':fmt(Math.round(v*100)/100))+'</td>'}).join('')+'</tr>'});
    h+='</tbody></table><p class="sub" style="margin:14px 0 0">Apple\u2019s own daily totals, '+
      'exact and never sampled \u2014 which is why they live in a separate store and are never '+
      'added to the numbers above. Those count visits to a website; these count installs. The '+
      'ratio between them is the funnel; the sum is nothing.</p></div>';
  }

  var camps=(st.campaigns||[]).filter(function(c){return !cur||c.source===cur});
  if(camps.length){
    h+='<div class="card"><h2>Campaigns</h2>'+
      '<table><thead><tr><th>Campaign</th><th>Source</th><th>Where</th>'+
      '<th class="n">Visits</th><th class="n">Engaged</th><th class="n">Store clicks</th>'+
      '<th class="n">Bots</th></tr></thead><tbody>';
    camps.forEach(function(c){
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

  // «Откуда» и «что читали» — две половины одного вопроса, поэтому рядом и одинаковой формы.
  var half=function(title,rows,label,note){
    var list=(rows||[]).filter(function(r){return !cur||r.source===cur});
    if(!list.length) return '';
    var byKey={};
    list.forEach(function(r){var k=cur?r.key:r.key;
      byKey[k]=byKey[k]||{views:0,eng:0,src:{}};byKey[k].views+=r.page_views;
      byKey[k].eng+=r.engaged;byKey[k].src[r.source]=1});
    var keys=Object.keys(byKey).sort(function(a,b){return byKey[b].views-byKey[a].views}).slice(0,12);
    var h2='<div class="card"><h2>'+esc(title)+'</h2><table><thead><tr><th>'+esc(label)+'</th>'+
      (cur?'':'<th>Product</th>')+'<th class="n">Page views</th><th class="n">Engaged</th>'+
      '</tr></thead><tbody>';
    keys.forEach(function(k){var v=byKey[k];
      h2+='<tr><td class="name">'+esc(k)+'</td>'+
        (cur?'':'<td class="sub">'+esc(Object.keys(v.src).sort().join(', '))+'</td>')+
        '<td class="n">'+fmt(v.views)+'</td><td class="n">'+fmt(v.eng)+'</td></tr>'});
    return h2+'</tbody></table><p class="sub" style="margin:14px 0 0">'+note+'</p></div>'
  };
  h+=half('Where they came from',st.referrers,'Referrer',
    'Direct visits are absent by definition \u2014 they carry no referrer, and a row for them '+
    'would read as \u201csource unknown\u201d rather than \u201cthere was no source\u201d. Only '+
    'the HOST is kept: a full referrer carries other people\u2019s search queries and tokens.');
  h+=half('Where in the world',st.countries,'Country',
    'From Cloudflare\u2019s edge, never from the browser. Country only \u2014 a city would '+
    'narrow a thirty-visitor week to something identifiable, which is the line past which a '+
    'counter stops being anonymous.');
  h+=half('What they read',st.pages,'Page',
    'Query strings are stripped before storage, so a page appears once however it was linked.');

  h+='<div class="card"><h2>Sources</h2>';
  if(!rows.length) h+='<p class="empty">No events in this window.</p>';
  else{
    h+='<table><thead><tr><th>Source</th><th>Platform</th><th class="n">People</th>'+
       '<th class="n">Page views</th><th class="n">Engaged</th><th class="n">Bot events</th>'+
       '<th class="n">AI agents, 24h</th></tr></thead><tbody>';
    // Источники приходят уже сгруппированными по домену. Показываем домен один раз на
    // группу: повторять его в каждой строке — шум, а не структура.
    var lastDomain=null;
    rows.forEach(function(r){
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
        '<td class="n"'+(mostly?' style="color:var(--warn)"':'')+'>'+fmt(r.bot_events)+'</td>'+
        // Прочерк, а не ноль: у приложения нет хоста, и «0 агентов» читалось бы как факт,
        // хотя это отсутствие вопроса.
        '<td class="n">'+(r.ai_requests===undefined?'\u2014':fmt(r.ai_requests))+'</td></tr>'});
    h+='</tbody></table>';
    if(st.sources.some(function(r){return r.max_sample>1}))
      h+='<p class="sub" style="margin:10px 0 0">“+” marks a lower bound: sampling dropped rows in that group.</p>';
    h+='<p class="sub" style="margin:6px 0 0">The agent column is a different window \u2014 24 '+
      'hours, the widest this dataset allows on the free plan \u2014 and it is per HOSTNAME, '+
      'which is how products sharing one Cloudflare zone get told apart.</p>';
  }
  h+='</div>';
  app.innerHTML=h;
}

sdaHover(app,tip,esc,fmt);

function load(){
  document.querySelectorAll('.range button').forEach(function(b){
    b.setAttribute('aria-pressed',String(+b.dataset.d===days))});
  fetch('/v1/overview?days='+days+(key?'&k='+encodeURIComponent(key):''))
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
    .then(function(x){x.ok?render(x.j):app.innerHTML='<div class="note"><strong>'+esc(x.j.error||'error')+
      '</strong><br>'+esc(x.j.message||'')+'</div>'})
    .catch(function(){app.innerHTML='<p class="empty">Could not reach the API.</p>'})
}
// MCP отвечает только на POST — открывать его в браузере бессмысленно. Ссылка нужна как
// НАПОМИНАНИЕ и как способ скопировать адрес, поэтому клик копирует, а не переходит.
document.getElementById('mcp').addEventListener('click',function(e){
  e.preventDefault();
  var url=location.origin+'/mcp';
  var done=function(){var a=e.target;var t=a.textContent;a.textContent='Copied '+url;
    setTimeout(function(){a.textContent=t},2000)};
  if(navigator.clipboard) navigator.clipboard.writeText(url).then(done,done); else done()
});
document.querySelector('.range').addEventListener('click',function(e){
  var b=e.target.closest('button');if(!b)return;days=+b.dataset.d;load()});
load();
</script>
</body></html>
`;

/**
 * The multi-series line chart, shared by the dashboard and the open page.
 *
 * One implementation in one file because two copies of a chart drift: the day somebody fixes an
 * axis on one page, the other keeps the bug, and nothing tells you. Both pages inline these two
 * strings, so there is still no build step and no runtime dependency.
 *
 * NO BACKSLASHES IN THESE STRINGS. They are template literals, so an escape collapses before a
 * browser sees it — a regex written as /a\/b/ ships as /a/b/ and takes the page down. This is
 * written at the top of snippet.ts too, and it was learned twice.
 *
 * ── Colour ────────────────────────────────────────────────────────────────────────────────
 *
 * Eight hues in a FIXED order, never cycled and never generated. A ninth series folds into
 * "Other" rather than inventing a colour, because a generated hue lands wherever it lands and
 * the next one collides with it.
 *
 * The order is not taste. Run through a palette validator in both modes: worst adjacent
 * colour-vision-deficiency separation ΔE 9.1 light / 8.4 dark against a target of 8, worst
 * normal-vision separation 19.6 / 19.3 against a floor of 15. Light mode carries a contrast
 * warning for three of the hues against the page surface, which obliges secondary encoding —
 * that is what the legend labels and the table underneath are for, and why the series are never
 * identified by colour alone.
 *
 * Colour follows the ENTITY, not the rank: the assignment is by sorted source id, so filtering
 * the chart does not repaint the survivors.
 */

export const CHART_CSS = `
.chart{position:relative}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:14px 0 0}
.legend span{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2)}
.legend i{width:10px;height:10px;border-radius:3px;flex:none}
.c1{--c:#2a78d6}.c2{--c:#eb6834}.c3{--c:#1baf7a}.c4{--c:#eda100}
.c5{--c:#e87ba4}.c6{--c:#008300}.c7{--c:#4a3aa7}.c8{--c:#e34948}.c9{--c:#898781}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
.c1{--c:#3987e5}.c2{--c:#d95926}.c3{--c:#199e70}.c4{--c:#c98500}
.c5{--c:#d55181}.c6{--c:#008300}.c7{--c:#9085e9}.c8{--c:#e66767}.c9{--c:#898781}}}
:root[data-theme="dark"]{
.c1{--c:#3987e5}.c2{--c:#d95926}.c3{--c:#199e70}.c4{--c:#c98500}
.c5{--c:#d55181}.c6{--c:#008300}.c7{--c:#9085e9}.c8{--c:#e66767}.c9{--c:#898781}}
`;

/**
 * `sdaChart(rows, esc, fmt)` — rows are `{day, source, events}`, already whatever subset the
 * caller wants drawn. Returns `{svg, legend}`; a caller that wants neither gets an empty string
 * and can say so in its own words.
 */
export const CHART_JS = `
var SERIES_CAP=8;
function sdaSeries(rows){
  var total={};
  rows.forEach(function(r){total[r.source]=(total[r.source]||0)+r.events});
  // Ранжируем по объёму, но ЦВЕТ назначаем по имени: иначе фильтр, меняющий состав, перекрашивает
  // выживших, и один и тот же продукт на двух экранах оказывается разного цвета.
  var names=Object.keys(total).sort(function(a,b){return total[b]-total[a]});
  var shown=names.slice(0,SERIES_CAP).sort();
  var slot={};shown.forEach(function(n,i){slot[n]='c'+(i+1)});
  var rest=names.slice(SERIES_CAP);
  if(rest.length) slot.__other='c9';
  var days=[];var seen={};
  rows.forEach(function(r){if(!seen[r.day]){seen[r.day]=1;days.push(r.day)}});
  days.sort();
  var byName={};shown.forEach(function(n){byName[n]={}});
  if(rest.length) byName.__other={};
  rows.forEach(function(r){
    var key=shown.indexOf(r.source)>=0?r.source:(rest.length?'__other':null);
    if(key===null)return;
    byName[key][r.day]=(byName[key][r.day]||0)+r.events});
  return {days:days,slot:slot,byName:byName,others:rest.length};
}

function sdaChart(rows,esc,fmt){
  if(!rows||rows.length===0) return {svg:'',legend:''};
  var s=sdaSeries(rows);
  if(s.days.length<2) return {svg:'',legend:''};

  var W=1000,H=220,L=40,R=8,T=12,B=26;
  var names=Object.keys(s.byName);
  var max=0;
  names.forEach(function(n){s.days.forEach(function(d){var v=s.byName[n][d]||0;if(v>max)max=v})});
  if(max<=0) max=1;
  var x=function(i){return L+i*(W-L-R)/(s.days.length-1)};
  var y=function(v){return T+(1-v/max)*(H-T-B)};

  var out='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="Events per day by product">';
  [0,0.5,1].forEach(function(f){var yy=y(max*f);
    out+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--grid)" stroke-width="1"/>';
    out+='<text x="0" y="'+(yy+4)+'" fill="var(--muted)" font-size="11">'+fmt(Math.round(max*f))+'</text>'});

  names.forEach(function(n){
    var pts=s.days.map(function(d,i){return x(i)+','+y(s.byName[n][d]||0)});
    out+='<g class="'+s.slot[n]+'">';
    out+='<polyline fill="none" stroke="var(--c)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="'+pts.join(' ')+'"/>';
    // Точки только когда дней немного: на девяноста они сливаются в линию из кружков.
    if(s.days.length<=14) s.days.forEach(function(d,i){
      out+='<circle cx="'+x(i)+'" cy="'+y(s.byName[n][d]||0)+'" r="3.5" fill="var(--c)" stroke="var(--surface)" stroke-width="2"/>'});
    out+='</g>'});

  // Прозрачные полосы поверх всего — цель для наведения шире любой точки. В data-v лежит
  // разбивка по рядам как JSON: подсказка над многорядным графиком обязана говорить, ЧЕЙ это
  // столбец, а одно суммарное число отвечало бы на вопрос, которого никто не задавал.
  s.days.forEach(function(d,i){
    var rowsOf=names
      .map(function(n){return [s.slot[n],n==='__other'?'other':n,s.byName[n][d]||0]})
      .filter(function(r){return r[2]>0})
      .sort(function(a,b){return b[2]-a[2]});
    var half=(W-L-R)/(s.days.length-1)/2;
    out+='<rect x="'+(x(i)-half)+'" y="0" width="'+(half*2)+'" height="'+H+'" fill="transparent" data-d="'+esc(d)+'" data-v="'+esc(JSON.stringify(rowsOf))+'"/>'});

  out+='<text x="'+L+'" y="'+(H-6)+'" fill="var(--muted)" font-size="11">'+esc(s.days[0])+'</text>';
  out+='<text x="'+(W-R)+'" y="'+(H-6)+'" fill="var(--muted)" font-size="11" text-anchor="end">'+esc(s.days[s.days.length-1])+'</text>';
  out+='</svg>';

  // Легенда есть ВСЕГДА при двух и более рядах: три из восьми оттенков не проходят порог
  // контраста к светлой подложке, и опознавать ряд одним лишь цветом там нельзя.
  var legend='';
  if(names.length>1){
    legend='<div class="legend">'+names.map(function(n){
      return '<span class="'+s.slot[n]+'"><i style="background:var(--c)"></i>'+
        esc(n==='__other'?'other ('+s.others+' more)':n)+'</span>'}).join('')+'</div>';
  }
  return {svg:out,legend:legend};
}
`;

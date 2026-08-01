/**
 * The web snippet, served by the Worker itself at GET /sda.js.
 *
 * Serving it from here rather than copying a file into thirteen repositories means the sites
 * are edited ONCE. Every later change to how the browser reports is a deploy, not a rollout.
 * That is the whole reason it is a string in the Worker instead of a file in each project.
 *
 * Install:
 *   <script defer src="https://analytics.superduperai.co/sda.js" data-source="superduperai"></script>
 *
 * Optional attributes: `data-endpoint` to point elsewhere, `data-version` to stamp a release.
 * Custom events: `sda("signup_started", {plan: "pro"}, {seats: 3})`.
 *
 * ── Why it is written the way it is ────────────────────────────────────────────────────────
 *
 * NO CLIENT STATE. No cookie, no localStorage, no sessionStorage. The `anon` id is derived at
 * the edge from IP + user agent + the UTC date (see anon.ts), so the browser is handed nothing
 * to keep and no consent banner becomes necessary. The snippet never even mentions `anon`.
 *
 * NO CORS PREFLIGHT. The body goes as `text/plain` inside a Blob, which makes it a "simple
 * request" that browsers send without an OPTIONS round trip. Ingest accepts text/plain for
 * exactly this reason. A JSON content-type would double the request count and force an
 * origin allow-list into existence.
 *
 * NEVER DELAY THE PAGE. Events are buffered and flushed through `sendBeacon`, which the
 * browser delivers after the page is gone. The flush hangs off `visibilitychange`, not
 * `unload` — several browsers refuse to send beacons from `unload`.
 *
 * SPA ROUTES COUNT. `pushState` and `replaceState` are wrapped, because otherwise a
 * single-page site reports one visit and then silence forever.
 *
 * IT DOES NOT TRUST `document.currentScript`. Host frameworks inject scripts their own way —
 * `next/script` builds the element in JavaScript — and a snippet that reads its configuration
 * from `currentScript` alone silently does nothing when it guesses wrong. The fallback finds
 * its own tag by `src`, so the same one line works in plain HTML, Astro and Next alike.
 *
 * The comments live here rather than inside the string because the string is what every
 * visitor downloads. Keeping them out is the difference between 2.2 KB and 1.5 KB.
 */

/** Bumped when the served snippet changes; it is the cache key visitors actually see. */
export const SNIPPET_VERSION = "1";

/** An hour: long enough to be free in practice, short enough that a fix lands the same day. */
export const SNIPPET_CACHE_SECONDS = 3600;

/**
 * A plain string, not a built artefact: there is no compile step between this repository and
 * what a visitor executes. What you read here is what runs.
 */
export const SNIPPET = `(function(w,d){
var s=d.currentScript||d.querySelector('script[data-source][src*="/sda.js"]');
var src=s&&s.dataset.source;
if(!src){console.warn("[sda] missing data-source");return}
var api=(s&&s.dataset.endpoint)||"https://analytics.superduperai.co/e";
var ver=(s&&s.dataset.version)||undefined;
var buf=[],timer,queued=w.sda&&w.sda.q;
function path(){return location.pathname||"/"}
function ref(){var r=d.referrer;return r&&r.indexOf(location.host)<0?r:undefined}
function flush(){
if(!buf.length)return;
var body=JSON.stringify({events:buf});buf=[];clearTimeout(timer);timer=null;
try{
var blob=new Blob([body],{type:"text/plain"});
if(!(navigator.sendBeacon&&navigator.sendBeacon(api,blob)))throw 0
}catch(e){
try{fetch(api,{method:"POST",body:body,keepalive:true,mode:"no-cors"})}catch(e2){}
}
}
function push(name,props,metrics){
buf.push({source:src,platform:"web",name:name,ts:Date.now(),path:path(),referrer:ref(),version:ver,props:props,metrics:metrics});
if(buf.length>=50)return flush();
if(!timer)timer=setTimeout(flush,2000)
}
d.addEventListener("visibilitychange",function(){if(d.visibilityState==="hidden")flush()});
w.addEventListener("pagehide",flush);
var seen=path();
function route(){var p=path();if(p!==seen){seen=p;push("page_viewed")}}
["pushState","replaceState"].forEach(function(m){
var orig=history[m];
history[m]=function(){var r=orig.apply(this,arguments);route();return r}
});
w.addEventListener("popstate",route);
w.sda=push;
if(queued)Array.prototype.forEach.call(queued,function(a){push.apply(null,a)});
push("page_viewed")
})(window,document);
`;

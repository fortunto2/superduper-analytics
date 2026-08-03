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
 * Custom events: `sda("signup_started", {plan: "pro"}, {seats: 3})`, or in the markup alone:
 *   <a href="…" data-sda-event="app_store_opened" data-sda-placement="hero">
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
 * IT DECLARES AUTOMATION AND ENGAGEMENT. `navigator.webdriver` and a headless user agent are
 * sent as `auto`, which ingest folds into `ua_kind` — that catches the scrapers that DO run
 * JavaScript and would otherwise look exactly like people. A one-off `page_engaged` event
 * fires on the first scroll, pointer or key press, because loading a page is what a crawler
 * does and interacting with it is what a person does. Neither needs a new blob slot: `auto`
 * folds into an existing one and `page_engaged` is just an event name, and event names were
 * left open for exactly this.
 *
 * CLICKS ARE MARKUP, NOT CODE. A `data-sda-event` attribute anywhere on the page is reported
 * on click, with `data-sda-placement` as a prop. Thirteen sites would otherwise each grow
 * their own copy of the same four-line listener, and the outbound click — the store button,
 * the signup — is the one event a landing page exists to produce. The listener captures, so a
 * handler that calls stopPropagation cannot hide a click from us, and it walks up from the
 * target, because the click always lands on the icon inside the button and never on the
 * button. It costs ~150 bytes raw and ~60 served; see the budget in the tests.
 *
 * IT DOES NOT TRUST `document.currentScript`. Host frameworks inject scripts their own way —
 * `next/script` builds the element in JavaScript — and a snippet that reads its configuration
 * from `currentScript` alone silently does nothing when it guesses wrong. The fallback finds
 * its own tag by `src`, so the same one line works in plain HTML, Astro and Next alike.
 *
 * The comments live here rather than inside the string because the string is what every
 * visitor downloads. Keeping them out is the difference between 2.2 KB and 1.5 KB.
 *
 * NO BACKSLASHES IN THE STRING. It is a template literal, so `\/` collapses to `/` before the
 * browser ever sees it. A regex written as `/…|Electron\//i` therefore shipped as
 * `/…|Electron//i` — terminating early and turning the rest into a division by `i`. The tests
 * that execute the snippet caught it; nothing else would have.
 */

/** Bumped when the served snippet changes. It is the ETag, so a stale browser revalidates
 * with a 304 instead of downloading the string again — see the /sda.js route. */
export const SNIPPET_VERSION = "2";

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
var buf=[],timer,queued=w.sda&&w.sda.q,engaged;
var nav=navigator,ua=nav.userAgent||"";
var auto=!!(nav.webdriver||/HeadlessChrome|PhantomJS|Electron/i.test(ua))||undefined;
function path(){return location.pathname||"/"}
function ref(){var r=d.referrer;return r&&r.indexOf(location.host)<0?r:undefined}
function flush(){
if(!buf.length)return;
var body=JSON.stringify({events:buf});buf=[];clearTimeout(timer);timer=null;
try{
var blob=new Blob([body],{type:"text/plain"});
if(!(nav.sendBeacon&&nav.sendBeacon(api,blob)))throw 0
}catch(e){
try{fetch(api,{method:"POST",body:body,keepalive:true,mode:"no-cors"})}catch(e2){}
}
}
function push(name,props,metrics){
buf.push({source:src,platform:"web",name:name,ts:Date.now(),path:path(),referrer:ref(),version:ver,auto:auto,props:props,metrics:metrics});
if(buf.length>=50)return flush();
if(!timer)timer=setTimeout(flush,2000)
}
function engage(){if(engaged)return;engaged=1;push("page_engaged")}
["scroll","pointerdown","keydown"].forEach(function(e){
w.addEventListener(e,engage,{passive:true})
});
d.addEventListener("click",function(e){
var t=e.target,c=t&&t.closest&&t.closest("[data-sda-event]"),a=c&&c.dataset;
if(a)push(a.sdaEvent,{placement:a.sdaPlacement||"unknown"})
},true);
d.addEventListener("visibilitychange",function(){if(d.hidden)flush()});
w.addEventListener("pagehide",flush);
var seen=path();
function route(){var p=path();if(p!==seen){seen=p;engaged=0;push("page_viewed")}}
["pushState","replaceState"].forEach(function(m){
var orig=history[m];
history[m]=function(){var r=orig.apply(this,arguments);route();return r}
});
w.addEventListener("popstate",route);
w.sda=push;
if(queued)[].forEach.call(queued,function(a){push.apply(null,a)});
push("page_viewed")
})(window,document);
`;

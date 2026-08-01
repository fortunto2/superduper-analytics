# Installing the counter

One line per site. The `data-source` must already exist in
[registry/sources.yaml](../registry/sources.yaml) — an unregistered source is refused with 403,
which is the whole access-control model.

```html
<script defer src="https://analytics.superduperai.co/sda.js" data-source="superduperai"></script>
```

Put it in `<head>`. `defer` means it never blocks rendering, and nothing is sent until the
visitor leaves the page.

## What arrives without any further work

`page_viewed` on load and on every SPA route change (`pushState`, `replaceState`, back/forward).
Path with the query string stripped, referrer reduced to its host, country from the edge, and
a `browser`/`bot` classification.

## Custom events

```js
sda("signup_started", { plan: "pro" }, { seats: 3 });
```

Name in `object_verb` past tense, snake_case. The second argument is string dimensions, the
third is numbers. Both optional. Events are batched and sent when the page is hidden, so a
click handler can fire one immediately before navigating away without losing it.

If you need to call `sda()` before the script has loaded, add a stub first:

```html
<script>window.sda=function(){(window.sda.q=window.sda.q||[]).push(arguments)}</script>
```

## Optional attributes

| Attribute | Effect |
|---|---|
| `data-version` | stamped on every event, so a regression can be pinned to a release |
| `data-endpoint` | point somewhere else; only useful for testing |

## The source list

| id | site |
|---|---|
| `superduperai` | https://superduperai.co |
| `live2play` | https://live2play.superduperai.co |
| `life2film` | https://life2film.com |
| `facealarm` | https://face-alarm.com |
| `you2idea` | https://you2idea.com |
| `miralinka` | https://miralinka.com |
| `miralinka-marafon` | https://marafon.miralinka.com |
| `books` | https://books.superduperai.co |
| `rusty` | https://rusty.superduperai.co |
| `promptwizard` | https://prompt.superduperai.co |
| `editor` | https://editor.superduperai.co |
| `rustman` | https://rustman.org |
| `akbuzat` | https://akbuzat.net |

## There is nothing to keep updated

The snippet is served by the Worker, not copied into each project. Every later change to how
the browser reports is a deploy here — the thirteen sites are edited once and never again.

## What it does not do

No cookie, no `localStorage`, no `sessionStorage`, no fingerprint handed back to the browser.
The anonymous id is derived at the edge from IP + user agent + the UTC date, rotates at
midnight, and is never sent to the client. That is what keeps the privacy text on every
property true and the consent banner unnecessary — and it is why installing this needs no
banner, no config and no legal review.

## Checking it worked

The counter is live on a site when its `page_viewed` count stops being zero:

```sh
curl -s "https://analytics.superduperai.co/v1/stats?days=1" | jq '.sources'
```

Cloudflare's own edge analytics already knows how much traffic each site really gets, so the
honest test is the ratio between the two — see the coverage panel in the dashboard.

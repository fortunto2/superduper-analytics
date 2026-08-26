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

`page_viewed` on load and on every SPA route change (`pushState`, `replaceState`, back/forward),
and `page_engaged` once per page on the first scroll, click or keypress. Path with the query
string stripped, referrer reduced to its host, country from the edge, and a `browser`/`bot`
classification.

**Telling people from crawlers** is the reason for both of the latter. A scraper loads a page;
a person interacts with it, so `page_engaged` is the hardest signal to fake cheaply. On top of
that the snippet declares `navigator.webdriver` and a headless user agent, which ingest folds
into the `bot` classification — that catches the automation that runs JavaScript and would
otherwise be indistinguishable from a visitor. It does not catch automation that deliberately
hides, and nothing short of a challenge would.

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

## Приложения: отладочная сборка обязана представляться автоматикой

Правило на одну строку, и стоит оно дороже, чем выглядит.

Событие несёт поле `auto`. Клиент, признавшийся, что он автоматизирован, получает
`ua_kind: "bot"` и после этого исключён из всех продуктовых чисел — людей, просмотров, целей,
конверсии и возвратов, — но сохраняется целиком и виден отдельной колонкой. В приложении это
`#if DEBUG` в единственной точке отправки:

```swift
event.auto = true   // #if DEBUG
```

**Почему не отдельный `-dev` источник в реестре.** Он тоже сработал бы, но однажды уедет в
релизную сборку и раздвоит воронку продукта на два id, которые уже не сложить. Флаг такой
ошибки не допускает: худшее, что случится, — релиз, помеченный как автоматика, и это видно
сразу по обвалу чисел, а не через квартал.

**Что происходит без флага.** `/v1/retention` считает установки как `DISTINCT anon` и отсеивает
только ботов. Отладочная сборка шлёт свой install-scoped UUID, значит каждый прогон с симулятора
— это новая установка, которая никогда не вернулась. График оттока получится нарисованным
собственными сборками, и выглядеть он будет как правдоподобный продуктовый факт, а не как сбой.
Такие ошибки не находятся по симптомам: искать нечего, всё работает.

Флаг надо ставить и СТАРЫМ событиям, а не только тем, что добавляются сегодня. Запуски с
отладочных сборок — как раз то, что топит числа сильнее всего, а `app_launched` обычно
написан раньше всех и про него забывают.

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

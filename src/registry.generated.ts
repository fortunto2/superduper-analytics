// GENERATED FILE — DO NOT EDIT.
// Source of truth is registry/sources.yaml. Regenerate with `make gen`; `make check` fails
// if this file has drifted from the registry.
//
// Committed on purpose: these are public identifiers, and a clean checkout must build without
// running a generator first.

/** Every id that may appear as `source` on an event — sites and apps, deduplicated. */
export const SOURCE_IDS = [
  "agentboard",
  "airsignal",
  "akbuzat",
  "books",
  "carettafriends",
  "currencypal",
  "driveandblock",
  "editor",
  "facealarm",
  "jawharpsynth",
  "kissmytask",
  "life2film",
  "live2play",
  "miralinka",
  "miralinka-marafon",
  "photosweep",
  "promptwizard",
  "receiptbrain",
  "rustman",
  "rusty",
  "superduperai",
  "superfinans",
  "swift-terminal",
  "turtle-careta",
  "visaphoto",
  "you2idea",
] as const;

/** Sites only, with the hostname used to match a site against its Cloudflare zone. */
export const SITES = [
  { id: "agentboard", name: "agentboard", host: "board.rustman.org", url: "https://board.rustman.org", open: true, retired: false, ga: "" },
  { id: "airsignal", name: "Air Signal", host: "airsignal.app", url: "https://airsignal.app", open: true, retired: false, ga: "" },
  { id: "akbuzat", name: "akbuzat", host: "akbuzat.net", url: "https://akbuzat.net", open: false, retired: false, ga: "" },
  { id: "books", name: "books", host: "books.superduperai.co", url: "https://books.superduperai.co", open: false, retired: false, ga: "" },
  { id: "carettafriends", name: "Caretta Friends", host: "app.carettafriends.com", url: "https://app.carettafriends.com", open: false, retired: false, ga: "" },
  { id: "editor", name: "editor", host: "editor.superduperai.co", url: "https://editor.superduperai.co", open: false, retired: true, ga: "" },
  { id: "facealarm", name: "facealarm", host: "face-alarm.com", url: "https://face-alarm.com", open: false, retired: false, ga: "" },
  { id: "life2film", name: "life2film", host: "life2film.com", url: "https://life2film.com", open: true, retired: false, ga: "397806603" },
  { id: "live2play", name: "live2play", host: "live2play.superduperai.co", url: "https://live2play.superduperai.co", open: true, retired: false, ga: "374549185" },
  { id: "miralinka", name: "miralinka", host: "miralinka.com", url: "https://miralinka.com", open: false, retired: false, ga: "346749650" },
  { id: "miralinka-marafon", name: "miralinka-marafon", host: "marafon.miralinka.com", url: "https://marafon.miralinka.com", open: false, retired: false, ga: "" },
  { id: "promptwizard", name: "promptwizard", host: "prompt.superduperai.co", url: "https://prompt.superduperai.co", open: false, retired: false, ga: "" },
  { id: "rustman", name: "rustman", host: "rustman.org", url: "https://rustman.org", open: false, retired: false, ga: "" },
  { id: "rusty", name: "rusty", host: "rusty.superduperai.co", url: "https://rusty.superduperai.co", open: false, retired: false, ga: "" },
  { id: "superduperai", name: "superduperai", host: "superduperai.co", url: "https://superduperai.co", open: true, retired: false, ga: "374549185" },
  { id: "turtle-careta", name: "Caretta Gazipaşa", host: "carettafriends.com", url: "https://carettafriends.com", open: false, retired: false, ga: "" },
  { id: "visaphoto", name: "VisaYes", host: "visayes.app", url: "https://visayes.app", open: true, retired: false, ga: "" },
  { id: "you2idea", name: "you2idea", host: "you2idea.com", url: "https://you2idea.com", open: false, retired: false, ga: "" },
] as const;

/** Apps with the id their store knows them by — what the daily store-report job iterates. */
export const APPS = [
  { id: "carettafriends", platform: "android", storeId: "", site: "carettafriends" },
  { id: "carettafriends", platform: "ios", storeId: "6794324877", site: "carettafriends" },
  { id: "currencypal", platform: "ios", storeId: "6759005730", site: null },
  { id: "driveandblock", platform: "ios", storeId: "6759738953", site: null },
  { id: "facealarm", platform: "ios", storeId: "6758454962", site: "facealarm" },
  { id: "jawharpsynth", platform: "ios", storeId: "6758465213", site: null },
  { id: "kissmytask", platform: "ios", storeId: "6758514439", site: null },
  { id: "life2film", platform: "ios", storeId: "6761656888", site: "life2film" },
  { id: "live2play", platform: "ios", storeId: "6794370589", site: "live2play" },
  { id: "photosweep", platform: "ios", storeId: "6794369239", site: null },
  { id: "receiptbrain", platform: "ios", storeId: "6759008528", site: null },
  { id: "superfinans", platform: "ios", storeId: "6759007613", site: null },
  { id: "swift-terminal", platform: "ios", storeId: "6758515520", site: null },
] as const;

/**
 * Числовые размерности со своим double-слотом, В ПОРЯДКЕ ПОЗИЦИЙ: первая — double2, и так далее.
 * Массив только дополняется; `check` сравнивает его с реестром и падает на перестановке.
 */
export const METRICS: readonly string[] = [
  "days_since_first",
  "items_total",
  "content_seconds",
  "render_seconds",
];

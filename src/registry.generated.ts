// GENERATED FILE — DO NOT EDIT.
// Source of truth is registry/sources.yaml. Regenerate with `make gen`; `make check` fails
// if this file has drifted from the registry.
//
// Committed on purpose: these are public identifiers, and a clean checkout must build without
// running a generator first.

/** Every id that may appear as `source` on an event — sites and apps, deduplicated. */
export const SOURCE_IDS = [
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
  "you2idea",
] as const;

/** Sites only, with the hostname used to match a site against its Cloudflare zone. */
export const SITES = [
  { id: "akbuzat", host: "akbuzat.net", url: "https://akbuzat.net", open: false },
  { id: "books", host: "books.superduperai.co", url: "https://books.superduperai.co", open: false },
  { id: "carettafriends", host: "app.carettafriends.com", url: "https://app.carettafriends.com", open: false },
  { id: "editor", host: "editor.superduperai.co", url: "https://editor.superduperai.co", open: false },
  { id: "facealarm", host: "face-alarm.com", url: "https://face-alarm.com", open: false },
  { id: "life2film", host: "life2film.com", url: "https://life2film.com", open: true },
  { id: "live2play", host: "live2play.superduperai.co", url: "https://live2play.superduperai.co", open: true },
  { id: "miralinka", host: "miralinka.com", url: "https://miralinka.com", open: false },
  { id: "miralinka-marafon", host: "marafon.miralinka.com", url: "https://marafon.miralinka.com", open: false },
  { id: "promptwizard", host: "prompt.superduperai.co", url: "https://prompt.superduperai.co", open: false },
  { id: "rustman", host: "rustman.org", url: "https://rustman.org", open: false },
  { id: "rusty", host: "rusty.superduperai.co", url: "https://rusty.superduperai.co", open: false },
  { id: "superduperai", host: "superduperai.co", url: "https://superduperai.co", open: true },
  { id: "you2idea", host: "you2idea.com", url: "https://you2idea.com", open: false },
] as const;

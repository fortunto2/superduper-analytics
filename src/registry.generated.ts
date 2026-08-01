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
  { id: "akbuzat", host: "akbuzat.net" },
  { id: "books", host: "books.superduperai.co" },
  { id: "editor", host: "editor.superduperai.co" },
  { id: "facealarm", host: "face-alarm.com" },
  { id: "life2film", host: "life2film.com" },
  { id: "live2play", host: "live2play.superduperai.co" },
  { id: "miralinka", host: "miralinka.com" },
  { id: "miralinka-marafon", host: "marafon.miralinka.com" },
  { id: "promptwizard", host: "prompt.superduperai.co" },
  { id: "rustman", host: "rustman.org" },
  { id: "rusty", host: "rusty.superduperai.co" },
  { id: "superduperai", host: "superduperai.co" },
  { id: "you2idea", host: "you2idea.com" },
] as const;

/**
 * Does the data lie? `make truth` runs these over what D1 holds; the solopreneur harness runs
 * that every day, so a lie is found by a check and not by the next person to quote a number.
 *
 * Every rule here paid for itself first: each one is a lie that sat in production until a
 * person happened to look. A rule without such a history does not belong here.
 *
 * Pure: rows in, findings out, no clock (today is an input) and no I/O. The CLI fetches.
 */

export type TruthInput = {
  /** UTC day the check runs on, YYYY-MM-DD. */
  today: string;
  /** Query rows summed per site over the search window. */
  search: { site: string; clicks: number; impressions: number }[];
  /** Every `store_sync` row. `ran` is a UTC day. */
  syncs: { provider: string; source: string; through: string; ran: string; note: string | null }[];
  /** Page views per site and counter over the page window — `own` and `ga4`. */
  pages: { source: string; provider: string; views: number }[];
  /** Web people per site per day over the spike window. */
  people: { source: string; day: string; people: number }[];
};

export type Finding = { rule: string; subject: string; detail: string };

/** Below this a coincidence is plausible: two dead sites both at 0 or 1 impressions. */
const COPY_MIN_IMPRESSIONS = 10;
/** A run counts as current within this many days; older ones are not this job's state. */
const RAN_RECENT_DAYS = 2;
/** Store reports lag two days (STORE_LAG_DAYS); five leaves room for one missed run. */
const STUCK_DAYS = 5;
/** CLAUDE.md, «Two counters»: a gap in units is noise, a gap of two is one counter blind. */
const COUNTER_RATIO = 2;
const COUNTER_MIN_VIEWS = 50;
/** Lightpanda, Oct 2026: a crawler looks exactly like a burst of people. */
const SPIKE_RATIO = 3;
const SPIKE_MIN_PEOPLE = 20;
const SPIKE_RECENT_DAYS = 3;

const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function truthFindings(input: TruthInput): Finding[] {
  const out: Finding[] = [];

  // search-copy, 4 Nov 2026: a domain property's queries were written to every site on it, and
  // four sites carried the same 35 clicks and 1166 impressions. Equal totals are a copy.
  const groups = new Map<string, string[]>();
  for (const s of input.search) {
    if (s.impressions < COPY_MIN_IMPRESSIONS) continue;
    const key = `${s.clicks}/${s.impressions}`;
    groups.set(key, [...(groups.get(key) ?? []), s.site]);
  }
  for (const [key, sites] of groups) {
    if (sites.length < 2) continue;
    out.push({
      rule: "search-copy",
      subject: sites.sort().join(", "),
      detail: `identical search totals ${key} clicks/impressions — one property written to several sites`,
    });
  }

  // sync-error, 4 Nov 2026: a 403 for an app that no longer existed rode along in every run's
  // note for weeks. One finding per distinct note, not per row: the note is per run.
  const recent = input.syncs.filter((s) => daysBetween(s.ran, input.today) <= RAN_RECENT_DAYS);
  const errors = new Map<string, Set<string>>();
  for (const s of recent) {
    if (s.note === null || !/error|\b40[13]\b|\b5\d\d\b|forbidden/i.test(s.note)) continue;
    const note = s.note.slice(0, 160);
    errors.set(note, (errors.get(note) ?? new Set()).add(s.provider));
  }
  for (const [note, providers] of errors) {
    out.push({ rule: "sync-error", subject: [...providers].sort().join(", "), detail: note });
  }

  // sync-stuck: the job ran today and the data did not move. A failure that writes nothing
  // looks exactly like a quiet day everywhere downstream.
  for (const s of recent) {
    const behind = daysBetween(s.through, input.today);
    if (behind <= STUCK_DAYS) continue;
    out.push({
      rule: "sync-stuck",
      subject: `${s.provider} ${s.source}`,
      detail: `ran ${s.ran} but holds data only through ${s.through} (${Math.round(behind)} days behind)`,
    });
  }

  // two-counters: our counter and GA4 on the same pages. They never sum; they only check
  // each other, and a factor of two means one of them is not seeing something.
  const views = new Map<string, { own: number; ga4: number }>();
  for (const p of input.pages) {
    const v = views.get(p.source) ?? { own: 0, ga4: 0 };
    if (p.provider === "own") v.own += p.views;
    if (p.provider === "ga4") v.ga4 += p.views;
    views.set(p.source, v);
  }
  for (const [source, v] of views) {
    if (v.own < COUNTER_MIN_VIEWS && v.ga4 < COUNTER_MIN_VIEWS) continue;
    if (v.own === 0 || v.ga4 === 0) continue; // a site without GA4 has nothing to compare
    const ratio = v.own / v.ga4;
    if (ratio <= COUNTER_RATIO && ratio >= 1 / COUNTER_RATIO) continue;
    out.push({
      rule: "two-counters",
      subject: source,
      detail: `own ${v.own} vs ga4 ${v.ga4} page views (×${ratio.toFixed(1)}) — one counter is blind to something`,
    });
  }

  // spike: airsignal.app showed 40 000 «people» in a month at one Google click — a headless
  // agent browser running our script. A burst is a crawler until a per-visitor look says not.
  const bySite = new Map<string, { day: string; people: number }[]>();
  for (const p of input.people) bySite.set(p.source, [...(bySite.get(p.source) ?? []), p]);
  for (const [source, rows] of bySite) {
    const recentRows = rows.filter((r) => daysBetween(r.day, input.today) <= SPIKE_RECENT_DAYS);
    const base = median(rows.filter((r) => daysBetween(r.day, input.today) > SPIKE_RECENT_DAYS).map((r) => r.people));
    for (const r of recentRows) {
      if (r.people < SPIKE_MIN_PEOPLE || r.people <= SPIKE_RATIO * Math.max(base, 1)) continue;
      out.push({
        rule: "spike",
        subject: `${source} ${r.day}`,
        detail: `${r.people} people against a median of ${base} — check the crawler shape (one page per anon, empty referrer) before believing it`,
      });
    }
  }

  return out;
}

/** The last line the harness stamps: it needs numbers, and every rule gets one. */
export function truthSummary(input: TruthInput, findings: Finding[]): string {
  const n = (rule: string) => findings.filter((f) => f.rule === rule).length;
  const sites = new Set([...input.search.map((s) => s.site), ...input.people.map((p) => p.source)]).size;
  return (
    `truth: ${sites} sites read, ${n("search-copy")} search copies, ${n("sync-error")} sync errors, ` +
    `${n("sync-stuck")} stuck syncs, ${n("two-counters")} counter gaps, ${n("spike")} spikes`
  );
}

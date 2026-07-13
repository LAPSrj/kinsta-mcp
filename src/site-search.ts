/**
 * Fuzzy site/environment search over the /sites?include_environments payload.
 *
 * Agents refer to a site the way a human remembers it — a half-right name, a
 * bare domain, a label. Exact matching (what KinstaClient.resolveSite does)
 * misses all of those, and the raw site list is ~75k tokens on a 90-site
 * account, so "list it and eyeball it" is not an option either. This module
 * scores every site against the query and returns a compact projection of the
 * best ones.
 *
 * Matching rules, in order of how much they matter (examples use a site named
 * "ACME - Workspace", whose `name` is "acmeworkspace"):
 *  - Normalize both sides to bare alphanumerics, so "ACME - Workspace",
 *    "acmeworkspace" and "acme workspace" are the same string.
 *  - Score query tokens with OR, not AND: one junk token must not sink an
 *    otherwise-good match — in "acme workware", "workware" matches nothing and
 *    "acme" still wins.
 *  - Fall back to trigram similarity per token, so a misspelled token still
 *    earns partial credit against the word it was aiming at.
 */

/** Query tokens/fields collapse to bare alphanumerics: "ACME - Workspace" → "acmeworkspace". */
export function normalize(s: string | undefined | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Split a query on whitespace/punctuation, then normalize each token. */
export function tokenize(query: string): string[] {
  return query
    .split(/[\s,/|]+/)
    .map(normalize)
    .filter(Boolean);
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 3) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigrams: 0 (nothing shared) → 1 (identical). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a);
  const B = trigrams(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

// A substring hit is strong evidence; how strong depends on how much of the
// field the token covers ("acme" against the label "acme" beats "acme" buried
// in "acmeworkspace").
const SUBSTRING_BASE = 0.75;
const SUBSTRING_COVERAGE = 0.2;
// Below this, trigram overlap is noise (short strings share grams by accident).
const FUZZY_FLOOR = 0.34;
// A fuzzy hit is always worth less than a substring hit.
const FUZZY_WEIGHT = 0.7;
// Substrings shorter than this match half the account ("ca", "wp").
const MIN_SUBSTRING_TOKEN = 3;
/** At or above this, we call it a match; below it, it's only a suggestion. */
export const MATCH_THRESHOLD = 0.6;
/** Below this a site is not even worth suggesting. */
const SUGGEST_FLOOR = 0.2;

function scoreToken(token: string, field: string): number {
  if (!field || !token) return 0;
  if (token === field) return 1;
  if (token.length >= MIN_SUBSTRING_TOKEN && field.includes(token)) {
    return SUBSTRING_BASE + SUBSTRING_COVERAGE * (token.length / field.length);
  }
  const sim = similarity(token, field);
  return sim >= FUZZY_FLOOR ? sim * FUZZY_WEIGHT : 0;
}

interface Field {
  value: string;
  weight: number;
}

/**
 * The searchable surface of a site. Weights encode how strongly a hit on that
 * field identifies the site: its own names and primary domain are definitive,
 * an environment's name ("Live", "Staging") barely narrows anything down.
 */
function fieldsOf(site: any): Field[] {
  const fields: Field[] = [
    { value: normalize(site.display_name), weight: 1 },
    { value: normalize(site.name), weight: 1 },
  ];
  for (const label of site.site_labels ?? []) {
    fields.push({ value: normalize(label?.name), weight: 0.75 });
  }
  for (const env of site.environments ?? []) {
    fields.push({ value: normalize(env?.display_name), weight: 0.5 });
    fields.push({ value: normalize(env?.name), weight: 0.5 });
    if (env?.primaryDomain?.name) {
      fields.push({ value: normalize(env.primaryDomain.name), weight: 1 });
    }
    for (const domain of env?.domains ?? []) {
      // Wildcards ("*.example.com") normalize to the same string as the apex
      // domain and add nothing; skip them rather than double-count.
      if (typeof domain?.name === "string" && !domain.name.startsWith("*.")) {
        fields.push({ value: normalize(domain.name), weight: 0.9 });
      }
    }
  }
  return fields.filter((f) => f.value);
}

/** Every id on the site — an exact id in the query is an unambiguous answer. */
function idsOf(site: any): string[] {
  const ids = [String(site.id ?? "")];
  for (const env of site.environments ?? []) if (env?.id) ids.push(String(env.id));
  return ids;
}

export interface ScoredSite {
  score: number;
  site: any;
}

/** Score one site: best field per token, averaged, OR'd against the whole query. */
export function scoreSite(site: any, query: string): number {
  const raw = query.trim().toLowerCase();
  if (raw && idsOf(site).some((id) => id.toLowerCase() === raw)) return 1;

  const fields = fieldsOf(site);
  if (!fields.length) return 0;

  const best = (token: string) =>
    Math.max(0, ...fields.map((f) => scoreToken(token, f.value) * f.weight));

  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const perToken = tokens.map(best);
  const mean = perToken.reduce((a, b) => a + b, 0) / perToken.length;

  // A multi-word query is also tried as one word, because a site's own `name`
  // is smashed together ("acmeworkspace") even when its display name isn't.
  const whole = tokens.length > 1 ? best(tokens.join("")) : 0;

  return Math.max(mean, whole);
}

export interface SearchOutcome {
  /** Scored at or above MATCH_THRESHOLD, best first. */
  matched: ScoredSite[];
  /** Below the threshold but not noise, best first. Only worth showing when `matched` is empty. */
  suggestions: ScoredSite[];
}

export function searchSites(sites: any[], query: string): SearchOutcome {
  const scored = sites
    .map((site) => ({ site, score: scoreSite(site, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    matched: scored.filter((s) => s.score >= MATCH_THRESHOLD),
    suggestions: scored.filter((s) => s.score < MATCH_THRESHOLD && s.score >= SUGGEST_FLOOR),
  };
}

/**
 * The fields an agent actually needs to act on a site, and nothing else. The
 * full payload runs ~450 tokens per environment (ssh_connection, container_info,
 * every wildcard domain); this is ~40.
 */
export function compactSite(site: any, includeEnvironments = true): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: site.id,
    name: site.name,
    display_name: site.display_name,
    status: site.status,
  };
  const labels = (site.site_labels ?? []).map((l: any) => l?.name).filter(Boolean);
  if (labels.length) out.labels = labels;

  if (includeEnvironments) {
    out.environments = (site.environments ?? []).map((e: any) => ({
      id: e.id,
      name: e.name,
      display_name: e.display_name,
      is_premium: e.is_premium,
      primary_domain: e.primaryDomain?.name ?? null,
      domains: (e.domains ?? [])
        .map((d: any) => d?.name)
        .filter((n: any) => typeof n === "string" && !n.startsWith("*.")),
      php_version: e.container_info?.php_engine_version ?? null,
      wordpress_version: e.wordpress_version ?? null,
      web_root: e.web_root ?? null,
    }));
  }
  return out;
}

/** Round for display — the exact float is noise to the reader. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

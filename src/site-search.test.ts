import { describe, expect, test } from "bun:test";
import { normalize, tokenize, searchSites, scoreSite, compactSite } from "./site-search.js";

// Shaped like a real /sites?include_environments=true response, with invented
// sites. "ACME - Workspace" is the interesting one: its display name is
// punctuated, its `name` is smashed together, and it's the target of the
// misspelled query below.
const WORKSPACE = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "acmeworkspace",
  display_name: "ACME - Workspace",
  status: "live",
  site_labels: [{ id: 3335, name: "launched" }],
  environments: [
    {
      id: "bbbbbbbb-0000-0000-0000-000000000001",
      name: "live",
      display_name: "Live",
      is_premium: true,
      web_root: "/www/acmeworkspace_944/public",
      wordpress_version: "6.7.1",
      container_info: { php_engine_version: "php8.1" },
      domains: [
        { id: "d1", name: "acmeworkspace.kinsta.cloud", type: "live" },
        { id: "d2", name: "*.acmeworkspace.kinsta.cloud", type: "live" },
        { id: "d3", name: "workspace.example.com", type: "live" },
      ],
      primaryDomain: { id: "d3", name: "workspace.example.com", type: "live" },
    },
    {
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      name: "staging",
      display_name: "Staging",
      is_premium: false,
      domains: [],
    },
  ],
};

const NIMBUS = {
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  name: "nimbusnorthshore",
  display_name: "Nimbus - North Shore",
  status: "live",
  site_labels: [{ id: 5273, name: "nimbus" }],
  environments: [
    {
      id: "bbbbbbbb-0000-0000-0000-000000000003",
      name: "live",
      display_name: "Live",
      is_premium: true,
      domains: [
        { id: "d4", name: "northshore.example.com", type: "live" },
        { id: "d5", name: "*.northshore.example.com", type: "live" },
      ],
      primaryDomain: { id: "d4", name: "northshore.example.com", type: "live" },
    },
  ],
};

const ZETA = {
  id: "aaaaaaaa-0000-0000-0000-000000000003",
  name: "zetawidgets",
  display_name: "Zeta Widgets",
  status: "live",
  site_labels: [],
  environments: [
    {
      id: "bbbbbbbb-0000-0000-0000-000000000004",
      name: "live",
      display_name: "Live",
      domains: [{ id: "d6", name: "zetawidgets.example.com", type: "live" }],
      primaryDomain: { id: "d6", name: "zetawidgets.example.com", type: "live" },
    },
  ],
};

const SITES = [WORKSPACE, NIMBUS, ZETA];
const top = (query: string) => {
  const { matched, suggestions } = searchSites(SITES, query);
  return (matched[0] ?? suggestions[0])?.site;
};

describe("normalize / tokenize", () => {
  test("collapses punctuation, case and spacing to one shape", () => {
    expect(normalize("ACME - Workspace")).toBe("acmeworkspace");
    expect(normalize("northshore.example.com")).toBe("northshoreexamplecom");
    expect(normalize("Nimbus — North_Shore")).toBe("nimbusnorthshore");
  });

  test("splits a query into normalized tokens", () => {
    expect(tokenize("ACME - Workspace")).toEqual(["acme", "workspace"]);
    expect(tokenize("  acme   workware ")).toEqual(["acme", "workware"]);
  });
});

describe("searchSites", () => {
  test("exact display name matches", () => {
    expect(top("ACME - Workspace")).toBe(WORKSPACE);
  });

  test("bare site name matches", () => {
    expect(top("acmeworkspace")).toBe(WORKSPACE);
  });

  test("word-order-normalized query matches the smashed-together site name", () => {
    const { matched } = searchSites(SITES, "acme workspace");
    expect(matched[0]?.site).toBe(WORKSPACE);
  });

  test("a misspelled token does not sink a good one — the case that motivated this", () => {
    // "workware" exists nowhere; "acme" is unique. OR-scoring must still surface
    // the site, even if only as the best suggestion.
    expect(top("acme workware")).toBe(WORKSPACE);
  });

  test("domain matches, apex or with punctuation", () => {
    expect(top("northshore.example.com")).toBe(NIMBUS);
    expect(top("northshore")).toBe(NIMBUS);
  });

  test("label matches", () => {
    expect(top("nimbus")).toBe(NIMBUS);
  });

  test("a site id short-circuits to that site", () => {
    const { matched } = searchSites(SITES, NIMBUS.id);
    expect(matched[0]?.site).toBe(NIMBUS);
    expect(matched[0]?.score).toBe(1);
  });

  test("an environment id resolves to its parent site", () => {
    const { matched } = searchSites(SITES, "bbbbbbbb-0000-0000-0000-000000000002");
    expect(matched[0]?.site).toBe(WORKSPACE);
  });

  test("a generic environment name alone is too weak to match", () => {
    // Every site has a "Live" and most a "Staging". Matching a site purely on
    // that would hand back the whole account.
    expect(searchSites(SITES, "live").matched).toHaveLength(0);
    expect(searchSites(SITES, "staging").matched).toHaveLength(0);
  });

  test("a hopeless query matches nothing and suggests nothing", () => {
    const { matched, suggestions } = searchSites(SITES, "zzzzqqqq");
    expect(matched).toHaveLength(0);
    expect(suggestions).toHaveLength(0);
  });

  test("results are ordered best-first", () => {
    const { matched } = searchSites(SITES, "workspace");
    expect(matched[0]?.site).toBe(WORKSPACE);
    expect(scoreSite(WORKSPACE, "workspace")).toBeGreaterThan(scoreSite(ZETA, "workspace"));
  });
});

describe("compactSite", () => {
  test("keeps the actionable fields and drops the bulk", () => {
    const c = compactSite(WORKSPACE) as any;
    expect(c.id).toBe(WORKSPACE.id);
    expect(c.labels).toEqual(["launched"]);
    expect(c.environments).toHaveLength(2);

    const live = c.environments[0];
    expect(live.id).toBe("bbbbbbbb-0000-0000-0000-000000000001");
    expect(live.primary_domain).toBe("workspace.example.com");
    expect(live.php_version).toBe("php8.1");
    // Wildcards are noise; ssh/container internals aren't what a lookup is for.
    expect(live.domains).toEqual(["acmeworkspace.kinsta.cloud", "workspace.example.com"]);
    expect(live.ssh_connection).toBeUndefined();
  });

  test("environments can be omitted", () => {
    expect(compactSite(WORKSPACE, false).environments).toBeUndefined();
  });
});

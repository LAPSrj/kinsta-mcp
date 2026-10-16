import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { KinstaClient } from "./kinsta-client.js";
import {
  parseProjectConfig,
  projectInstructions,
  adaptShape,
  resolveProjectArgs,
  type ProjectConfig,
} from "./project.js";

// Two invented sites, each with a "live" environment, so a bare "live" is
// ambiguous across the company and only the project config can say which.
const ACME = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "acme",
  display_name: "ACME",
  environments: [
    { id: "bbbbbbbb-0000-0000-0000-000000000001", name: "live", display_name: "Live" },
    { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "staging", display_name: "Staging" },
    { id: "bbbbbbbb-0000-0000-0000-000000000003", name: "dev2", display_name: "Dev 2" },
  ],
};
const SHOP = {
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  name: "acmeshop",
  display_name: "ACME Shop",
  environments: [{ id: "cccccccc-0000-0000-0000-000000000001", name: "live", display_name: "Live" }],
};

function fakeClient(): KinstaClient {
  const client = new KinstaClient({ apiKey: "test", companyId: "company" });
  client.listSites = async () => [ACME, SHOP];
  return client;
}

describe("parseProjectConfig", () => {
  test("bare names belong to KINSTA_SITE; site/env and name= entries are read", () => {
    const c = parseProjectConfig("acme", "live, staging,qa=Dev 2, shop=acmeshop/live");
    expect(c).toEqual({
      site: "acme",
      environments: [
        { alias: "live", site: "acme", environment: "live" },
        { alias: "staging", site: "acme", environment: "staging" },
        { alias: "qa", site: "acme", environment: "Dev 2" },
        { alias: "shop", site: "acmeshop", environment: "live" },
      ],
    });
  });

  test("environments on other sites work without KINSTA_SITE", () => {
    const c = parseProjectConfig(undefined, "acme/live,shop=acmeshop/live");
    expect(c.site).toBeUndefined();
    expect(c.environments.map((e) => e.alias)).toEqual(["live", "shop"]);
  });

  test("two entries with the same name are rejected, case-insensitively", () => {
    expect(() => parseProjectConfig("acme", "live,acmeshop/Live")).toThrow(/both called "Live"/);
  });

  test("a bare name without KINSTA_SITE is rejected", () => {
    expect(() => parseProjectConfig(undefined, "staging")).toThrow(/KINSTA_SITE isn't set/);
  });

  test("nothing set → not configured, no instructions", () => {
    const c = parseProjectConfig(undefined, undefined);
    expect(c).toEqual({ site: undefined, environments: [] });
    expect(projectInstructions(c)).toBeUndefined();
  });

  test("instructions list the names, with the target where the name hides it", () => {
    const text = projectInstructions(parseProjectConfig("acme", "live,qa=Dev 2,shop=acmeshop/live"))!;
    expect(text).toContain('site "acme"');
    expect(text).toContain("live, qa (Dev 2), shop (acmeshop/live)");
  });
});

describe("adaptShape", () => {
  const config = parseProjectConfig("acme", "live,staging");

  test("a required site_id becomes optional; env params list the project's names", () => {
    const { shape, plan } = adaptShape(config, { site_id: z.string(), env_id: z.string() });
    expect((shape.site_id as z.ZodTypeAny).safeParse(undefined).success).toBe(true);
    expect((shape.env_id as z.ZodTypeAny).safeParse(undefined).success).toBe(false);
    expect((shape.env_id as z.ZodTypeAny).description).toContain("live, staging");
    expect([...plan.defaulted]).toEqual(["site_id"]);
  });

  test("`site` stays required on a site-wide tool (delete_site, reset_site)", () => {
    const { shape, plan } = adaptShape(config, { site: z.string() });
    expect((shape.site as z.ZodTypeAny).safeParse(undefined).success).toBe(false);
    expect(plan.defaulted.size).toBe(0);
  });

  test("`site` defaults on a tool that also takes environments (push_environment)", () => {
    const { plan } = adaptShape(config, {
      site: z.string(),
      source_environment: z.string(),
      target_environment: z.string(),
    });
    expect([...plan.defaulted]).toEqual(["site"]);
  });

  test("an optional site_id filter is left alone (list_activity_logs)", () => {
    const { plan } = adaptShape(config, { site_id: z.string().optional() });
    expect(plan.defaulted.size).toBe(0);
  });

  test("without a project config the shape is unchanged", () => {
    const original = { site_id: z.string(), env_id: z.string() };
    expect(adaptShape(parseProjectConfig(), original).shape).toBe(original);
  });
});

describe("resolveProjectArgs", () => {
  const config: ProjectConfig = parseProjectConfig("acme", "live,staging,qa=Dev 2,shop=acmeshop/live");
  const client = fakeClient();
  const plan = (shape: z.ZodRawShape, c = config) => adaptShape(c, shape).plan;

  test("project names become ids, including one on another site", async () => {
    const p = plan({ env_id: z.string() });
    expect((await resolveProjectArgs(config, client, p, { env_id: "staging" })).env_id).toBe(ACME.environments[1]!.id);
    expect((await resolveProjectArgs(config, client, p, { env_id: "qa" })).env_id).toBe(ACME.environments[2]!.id);
    expect((await resolveProjectArgs(config, client, p, { env_id: "shop" })).env_id).toBe(SHOP.environments[0]!.id);
  });

  test("an unlisted environment of KINSTA_SITE still resolves by name", async () => {
    const c = parseProjectConfig("acme", "live");
    const out = await resolveProjectArgs(c, client, plan({ env_id: z.string() }, c), { env_id: "Dev 2" });
    expect(out.env_id).toBe(ACME.environments[2]!.id);
  });

  test("an id passes through untouched", async () => {
    const id = "dddddddd-0000-0000-0000-000000000009";
    const out = await resolveProjectArgs(config, client, plan({ env_id: z.string() }), { env_id: id });
    expect(out.env_id).toBe(id);
  });

  test("site_id defaults to the site of the environment passed", async () => {
    const out = await resolveProjectArgs(config, client, plan({ site_id: z.string(), env_id: z.string() }), {
      env_id: "shop",
    });
    expect(out).toEqual({ site_id: SHOP.id, env_id: SHOP.environments[0]!.id });
  });

  test("site_id defaults to KINSTA_SITE when no environment is passed", async () => {
    const out = await resolveProjectArgs(config, client, plan({ site_id: z.string() }), {});
    expect(out.site_id).toBe(ACME.id);
  });

  test("a site_id name becomes an id", async () => {
    const out = await resolveProjectArgs(config, client, plan({ site_id: z.string() }), { site_id: "ACME Shop" });
    expect(out.site_id).toBe(SHOP.id);
  });

  test("an explicit site scopes the name and turns project names off", async () => {
    const p = plan({ site: z.string(), environment: z.string() });
    const out = await resolveProjectArgs(config, client, p, { site: "acmeshop", environment: "live" });
    expect(out.environment).toBe(SHOP.environments[0]!.id);
    await expect(resolveProjectArgs(config, client, p, { site: "acmeshop", environment: "staging" })).rejects.toThrow(
      /No environment matching "staging"/,
    );
  });

  test("environments on two sites can't fill one site parameter", async () => {
    const p = plan({ site: z.string(), source_environment: z.string(), target_environment: z.string() });
    await expect(
      resolveProjectArgs(config, client, p, { source_environment: "shop", target_environment: "live" }),
    ).rejects.toThrow(/different sites/);
  });

  test("without KINSTA_SITE, a name must be unique across the company", async () => {
    const c = parseProjectConfig(undefined, "shop=acmeshop/live");
    const p = plan({ env_id: z.string() }, c);
    expect((await resolveProjectArgs(c, client, p, { env_id: "shop" })).env_id).toBe(SHOP.environments[0]!.id);
    await expect(resolveProjectArgs(c, client, p, { env_id: "live" })).rejects.toThrow(/multiple sites/);
  });
});

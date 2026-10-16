/**
 * Per-project site and environments, set in the `env` block of a project's
 * .mcp.json so an agent working in that project never has to search for them:
 *
 *   "KINSTA_SITE": "acmeworkspace",
 *   "KINSTA_ENVIRONMENTS": "live,staging,shop=acme-shop/live"
 *
 * KINSTA_SITE is the project's site (name or id). KINSTA_ENVIRONMENTS is a
 * comma-separated list of `[name=][site/]environment` entries:
 *  - `staging`            → the "staging" environment of KINSTA_SITE, called "staging"
 *  - `acme-shop/live`     → the "live" environment of site acme-shop, called "live"
 *  - `shop=acme-shop/live` → the same environment, called "shop"
 * The `name=` part is only needed when two entries would share a name (two
 * sites each have a "live"). Names must be unique, case-insensitively.
 *
 * With either variable set, every environment parameter accepts those names,
 * a required site_id becomes optional (it defaults to the site of the
 * environment passed, else to KINSTA_SITE), and the server instructions tell
 * the agent which site and environments the project uses. Ids are stored
 * nowhere: names are turned into ids on each call from the cached site list,
 * so a deleted and recreated staging environment keeps working.
 */

import { z } from "zod";
import { KinstaClient, KinstaError, isUuid } from "./kinsta-client.js";

export interface ProjectEnvironment {
  /** What the agent passes: the `name=` part, else the environment name. */
  alias: string;
  /** Site name or id: the entry's `site/` part, else KINSTA_SITE. */
  site: string;
  /** Environment name or id within that site. */
  environment: string;
}

export interface ProjectConfig {
  site?: string;
  environments: ProjectEnvironment[];
}

/** Parse KINSTA_SITE / KINSTA_ENVIRONMENTS. Throws on an entry that can't be used. */
export function parseProjectConfig(site?: string, environments?: string): ProjectConfig {
  const defaultSite = site?.trim() || undefined;
  const envs: ProjectEnvironment[] = [];

  for (const raw of (environments ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;

    const eq = entry.indexOf("=");
    const alias = eq === -1 ? undefined : entry.slice(0, eq).trim();
    const target = eq === -1 ? entry : entry.slice(eq + 1).trim();
    const slash = target.lastIndexOf("/");
    const envSite = slash === -1 ? undefined : target.slice(0, slash).trim() || undefined;
    const environment = target.slice(slash + 1).trim();

    if (alias === "") {
      throw new Error(`KINSTA_ENVIRONMENTS entry "${entry}" has nothing before the "=".`);
    }
    if (!environment) {
      throw new Error(`KINSTA_ENVIRONMENTS entry "${entry}" doesn't name an environment.`);
    }
    const entrySite = envSite ?? defaultSite;
    if (!entrySite) {
      throw new Error(
        `KINSTA_ENVIRONMENTS entry "${entry}" doesn't name a site and KINSTA_SITE isn't set. ` +
          `Write it as <site>/${environment}, or set KINSTA_SITE.`,
      );
    }
    const name = alias ?? environment;
    if (envs.some((e) => e.alias.toLowerCase() === name.toLowerCase())) {
      throw new Error(
        `Two KINSTA_ENVIRONMENTS entries are both called "${name}". ` +
          `Give one its own name, e.g. "${name}2=${target}".`,
      );
    }
    envs.push({ alias: name, site: entrySite, environment });
  }

  return { site: defaultSite, environments: envs };
}

export function isConfigured(config: ProjectConfig): boolean {
  return !!config.site || config.environments.length > 0;
}

/** "live, staging, shop (acme-shop/live)": the detail shows only where the name hides it. */
function environmentList(config: ProjectConfig): string {
  return config.environments
    .map((e) => {
      if (e.site !== config.site) return `${e.alias} (${e.site}/${e.environment})`;
      if (e.alias !== e.environment) return `${e.alias} (${e.environment})`;
      return e.alias;
    })
    .join(", ");
}

/** The MCP server instructions for a configured project, or undefined. */
export function projectInstructions(config: ProjectConfig): string | undefined {
  if (!isConfigured(config)) return undefined;
  const parts: string[] = [];
  if (config.site) parts.push(`This project uses the Kinsta site "${config.site}".`);
  if (config.environments.length) {
    parts.push(
      `Its environments are: ${environmentList(config)}. Pass one of these names wherever a tool ` +
        `asks for an environment (env_id, environment_id, environment, ...).`,
    );
  }
  parts.push(
    `Site parameters default to the project's site, so there's no need to call find_site for it. ` +
      `Always name the environment: a tool never picks one for you.`,
  );
  return parts.join(" ");
}

// Parameters that identify an environment or a site. The `site_id`/`env_id`
// style ones are sent to the API as ids; the `site`/`environment` ones are
// resolved by the tool itself, which also accepts the ids we hand it.
const ENV_KEYS = new Set([
  "env_id",
  "environment_id",
  "source_env_id",
  "environment",
  "source_environment",
  "target_environment",
]);
const SITE_KEYS = new Set(["site_id", "site"]);

export interface ArgPlan {
  envKeys: string[];
  siteKeys: string[];
  /** Site keys that were required and now default from the project. */
  defaulted: Set<string>;
}

function describe(schema: z.ZodTypeAny, extra: string): z.ZodTypeAny {
  return schema.describe(schema.description ? `${schema.description} ${extra}` : extra);
}

/**
 * The shape a tool registers with: environment parameters say which names the
 * project has, and a required site parameter becomes optional when the project
 * can supply it. `site` on a tool with no environment parameter (delete_site,
 * reset_site) stays required, so a site-wide destructive action always names
 * its site.
 */
export function adaptShape<S extends z.ZodRawShape>(
  config: ProjectConfig,
  shape: S,
): { shape: z.ZodRawShape; plan: ArgPlan } {
  const keys = Object.keys(shape);
  const envKeys = keys.filter((k) => ENV_KEYS.has(k));
  const siteKeys = keys.filter((k) => SITE_KEYS.has(k));
  const defaulted = new Set<string>();
  if (!isConfigured(config)) return { shape, plan: { envKeys, siteKeys, defaulted } };

  const out: Record<string, unknown> = { ...shape };
  const envHint = config.environments.length
    ? `This project's environments: ${environmentList(config)}.` +
      (config.site ? ` Any other environment name of site "${config.site}", or an id, also works.` : " An id also works.")
    : `Accepts an environment name of this project's site "${config.site}" (e.g. live, staging) or an id.`;
  for (const k of envKeys) out[k] = describe(shape[k] as z.ZodTypeAny, envHint);

  for (const k of siteKeys) {
    const schema = shape[k] as z.ZodTypeAny;
    const required = !schema.safeParse(undefined).success;
    const eligible = k === "site_id" || envKeys.length > 0;
    const canDefault = !!config.site || (envKeys.length > 0 && config.environments.length > 0);
    if (!required || !eligible || !canDefault) continue;
    const hint = envKeys.length
      ? `Defaults to the site of the environment passed${config.site ? `, else to this project's site "${config.site}"` : ""}.`
      : `Defaults to this project's site "${config.site}".`;
    out[k] = describe(schema.optional(), hint);
    defaulted.add(k);
  }
  return { shape: out as z.ZodRawShape, plan: { envKeys, siteKeys, defaulted } };
}

/** The environment `env` of `site`, found in the cached site list. */
async function environmentOf(
  client: KinstaClient,
  site: string,
  env: string,
  company?: string,
): Promise<{ id: string; siteId: string }> {
  const ref = await client.resolveSite(site, company);
  const record = (await client.listSites(company)).find((s) => s.id === ref.id);
  const e = client.findEnvironment(record?.environments ?? [], env);
  if (!e) {
    throw new KinstaError(
      `No environment matching "${env}" in site "${ref.display_name}". Use list_environments.`,
      404,
      null,
    );
  }
  return { id: e.id, siteId: ref.id };
}

/**
 * An environment argument → its id. An explicit site in the call scopes the
 * lookup and turns the project names off (the caller asked for another site);
 * otherwise a project name wins, then a name in KINSTA_SITE, then a name that
 * is unique across the company.
 */
async function resolveEnvironmentArg(
  config: ProjectConfig,
  client: KinstaClient,
  value: string,
  explicitSite: string | undefined,
  company?: string,
): Promise<{ id: string; siteId?: string }> {
  if (isUuid(value)) return { id: value };
  if (!explicitSite) {
    const named = config.environments.find((e) => e.alias.toLowerCase() === value.toLowerCase());
    if (named) return environmentOf(client, named.site, named.environment, company);
  }
  const site = explicitSite ?? config.site;
  if (site) return environmentOf(client, site, value, company);
  const e = await client.resolveEnvironment(value, { company });
  return { id: e.id, siteId: e.site?.id };
}

/**
 * Fill a call's site and environment arguments from the project: environment
 * names become ids, and a defaulted site key gets the site of the environments
 * passed (they must agree), else KINSTA_SITE.
 */
export async function resolveProjectArgs(
  config: ProjectConfig,
  client: KinstaClient,
  plan: ArgPlan,
  args: Record<string, any>,
): Promise<Record<string, any>> {
  const out = { ...args };
  const company: string | undefined = args.company_id;
  const given = (k: string) => (typeof out[k] === "string" && out[k].trim() ? out[k].trim() : undefined);
  const explicitSite = plan.siteKeys.map(given).find(Boolean);

  const siteIds = new Set<string>();
  let envWithoutSite: string | undefined;
  for (const k of plan.envKeys) {
    const value = given(k);
    if (!value) continue;
    const r = await resolveEnvironmentArg(config, client, value, explicitSite, company);
    out[k] = r.id;
    if (r.siteId) siteIds.add(r.siteId);
    else envWithoutSite = r.id;
  }

  for (const k of plan.siteKeys) {
    const value = given(k);
    if (value) {
      if (k === "site_id" && !isUuid(value)) out[k] = (await client.resolveSite(value, company)).id;
      continue;
    }
    if (!plan.defaulted.has(k)) continue;

    if (siteIds.size > 1) {
      throw new KinstaError(
        `The environments in this call are on different sites. Pass \`${k}\` to say which site is meant.`,
        400,
        null,
      );
    }
    if (siteIds.size === 1) {
      out[k] = [...siteIds][0];
    } else if (envWithoutSite) {
      const e = await client.resolveEnvironment(envWithoutSite, { company });
      if (!e.site) throw new KinstaError(`Couldn't find the site of environment ${envWithoutSite}. Pass \`${k}\`.`, 404, null);
      out[k] = e.site.id;
    } else if (config.site) {
      out[k] = (await client.resolveSite(config.site, company)).id;
    } else {
      throw new KinstaError(`\`${k}\` is required, because this project has no KINSTA_SITE set.`, 400, null);
    }
  }
  return out;
}

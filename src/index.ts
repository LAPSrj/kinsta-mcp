#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { KinstaClient, KinstaError, isUuid } from "./kinsta-client.js";
import { searchSites, compactSite, round2 } from "./site-search.js";
import { requireAuthorization, setAuthorizationMode } from "./auth-guard.js";
import { runCli, type ToolEntry, type ToolResult } from "./cli.js";

// ── Mode: MCP server on stdio (no args) vs one-shot CLI call ─
// Both modes read the same tool registry below, so every tool is reachable
// either way and neither can drift from the other.
const CLI_ARGS = process.argv.slice(2).filter((a) => a !== "--stdio");
const CLI_MODE = CLI_ARGS.length > 0 && !process.argv.includes("--stdio");
// `tools` / `help` describe the surface; they don't call the API, so they must
// work without credentials configured.
const CLI_META_ONLY =
  CLI_MODE && ["tools", "list", "help", "--help", "-h"].includes(CLI_ARGS[0]!);

// ── Config: env first, then on-disk credential files ────────
// The secret lives in one place — a 0600 file under ~/.config/kinsta-mcp —
// that the server loads itself. This lets every project's .mcp.json be a bare
// launch block (no env, no secret, no ${VAR} to resolve at spawn time). An
// explicit env var still wins, so inline configs keep working unchanged.
const CREDENTIALS_DIR = path.join(os.homedir(), ".config", "kinsta-mcp");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "api-key");
const COMPANY_ID_FILE = path.join(CREDENTIALS_DIR, "company-id");

function readTrimmed(file: string): string | undefined {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

// env KINSTA_API_KEY → env KINSTA_API_KEY_FILE → default credential file.
function resolveApiKey(): string {
  const fromEnv = process.env.KINSTA_API_KEY;
  if (fromEnv) return fromEnv;
  const file = process.env.KINSTA_API_KEY_FILE || CREDENTIALS_FILE;
  const fromFile = readTrimmed(file);
  if (fromFile) return fromFile;
  if (CLI_META_ONLY) return "";
  console.error(
    `No Kinsta API key found: set KINSTA_API_KEY, or write the key to ${file} (mode 0600).`,
  );
  process.exit(1);
}

const API_KEY = resolveApiKey();
// env KINSTA_COMPANY_ID → default company-id file → undefined (per-call company_id still works).
const COMPANY_ID =
  process.env.KINSTA_COMPANY_ID || readTrimmed(COMPANY_ID_FILE);
const numEnv = (v: string | undefined) => (v ? Number(v) : undefined);

const client = new KinstaClient({
  apiKey: API_KEY,
  companyId: COMPANY_ID,
  maxConcurrency: numEnv(process.env.KINSTA_MAX_CONCURRENT_REQUESTS),
  creationPerMinute: numEnv(process.env.KINSTA_CREATION_PER_MINUTE),
  maxRetryDelayMs: numEnv(process.env.KINSTA_MAX_RETRY_DELAY_MS),
  maxRetries: numEnv(process.env.KINSTA_MAX_RETRIES),
  sitesTtlMs: numEnv(process.env.KINSTA_SITES_TTL_MS),
});

// Absolute path to the operation monitor script (works in dev + dist).
const MONITOR_SCRIPT = fileURLToPath(
  new URL("../scripts/operation-monitor.ts", import.meta.url),
);

// ── Result helpers ──────────────────────────────────────────
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});
const pretty = (data: unknown): string => {
  if (data === undefined || data === null) return "(no content)";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
};

function findOperationId(data: any): string | undefined {
  return data?.operation_id ?? data?.data?.operation_id;
}

// Where the API key is persisted for the monitor to read. Mirrors gmail-mcp:
// the secret lives on disk (mode 0600), and only its PATH is inlined into the
// Monitor command — never the key itself. Monitor spawns children with a
// stripped env, so the child reads the key from this file.
// (CREDENTIALS_DIR/CREDENTIALS_FILE are defined with the config resolvers above.)

let credentialsWritten = false;
function ensureCredentialsFile(): string {
  if (!credentialsWritten) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CREDENTIALS_FILE, API_KEY ?? "", { mode: 0o600 });
    // Tighten in case the file pre-existed with looser perms.
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
    credentialsWritten = true;
  }
  return CREDENTIALS_FILE;
}

function monitorCommand(operationId: string): string {
  // Persist the key to the default on-disk location; the monitor reads it from
  // there itself. Nothing secret — and not even the path — goes on the command
  // line. (operation-monitor.ts defaults to the same CREDENTIALS_FILE path, so
  // inlining it would be redundant; a custom location can still be passed via
  // KINSTA_API_KEY_FILE.) Mirrors gmail-mcp keeping its tokens on disk.
  ensureCredentialsFile();
  return `bun ${MONITOR_SCRIPT} --id ${operationId}`;
}

/**
 * Format a mutation result. If the API returned an operation_id (async 202),
 * include the id, a one-shot status hint, and a ready-to-run Monitor command.
 */
function formatResult(data: any, opNoun = "operation"): ToolResult {
  const operationId = findOperationId(data);
  if (!operationId) return ok(pretty(data));
  const message = data?.message ?? data?.data?.message ?? "";
  const cmd = monitorCommand(operationId);
  const text = [
    `Started async ${opNoun}.`,
    message ? `Message: ${message}` : "",
    `operation_id: ${operationId}`,
    ``,
    `To watch it to completion, set up a background watcher by passing this to the Monitor tool:`,
    `  command: ${cmd}`,
    `  (each stdout line is a JSON status event; it exits when the op succeeds or fails)`,
    ``,
    `Or check once with the get_operation tool (operation_id above).`,
    `Note: site-creation ops may briefly 404 right after starting — the monitor handles that.`,
  ]
    .filter(Boolean)
    .join("\n");
  return ok(text);
}

/**
 * Resolve a site (by name or id) to its id + a friendly guard label. Genuine
 * "not found / ambiguous" errors (404/409) propagate so the user can fix the
 * name; transport/auth failures fall back to the raw identifier so the guard
 * still runs and fails closed.
 */
async function siteTarget(
  site: string,
  company_id?: string,
): Promise<{ id: string; label: string }> {
  try {
    const s = await client.resolveSite(site, company_id);
    return { id: s.id, label: `the site "${s.display_name}" (id ${s.id})` };
  } catch (e) {
    if (e instanceof KinstaError && (e.status === 404 || e.status === 409)) throw e;
    return { id: site, label: `the site ${site}` };
  }
}

/** Resolve an environment (by name or id, optionally scoped to a site) to its
 * id + a friendly guard label. Same error policy as siteTarget. */
async function envTarget(
  environment: string,
  site: string | undefined,
  company_id?: string,
): Promise<{ id: string; siteId?: string; label: string }> {
  try {
    const e = await client.resolveEnvironment(environment, { site, company: company_id });
    const sName = e.site?.display_name ?? site ?? "unknown site";
    return {
      id: e.id,
      siteId: e.site?.id,
      label: `the "${e.display_name}" environment of site "${sName}"`,
    };
  } catch (err) {
    if (err instanceof KinstaError && (err.status === 404 || err.status === 409)) throw err;
    return { id: environment, label: `the environment ${environment}` };
  }
}

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof KinstaError) {
      return fail(`${e.message}${e.body ? `\n${pretty(e.body)}` : ""}`);
    }
    return fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Tool registry ───────────────────────────────────────────
// Every tool registers itself once, here, and lands in two places: the MCP
// server (for stdio clients) and TOOLS (for the CLI dispatcher). `server.tool`
// keeps the SDK's signature, so registration sites read exactly as before.
const mcp = new McpServer({ name: "kinsta", version: "1.0.0" });
const TOOLS = new Map<string, ToolEntry>();

const server = {
  tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => ToolResult | Promise<ToolResult>,
  ): void {
    TOOLS.set(name, { name, description, shape, handler: handler as (args: any) => any });
    mcp.tool(name, description, shape, handler as any);
  },
};

const companyParam = {
  company_id: z
    .string()
    .optional()
    .describe("Company ID. Defaults to KINSTA_COMPANY_ID if set."),
};

// ════════════════════════════════════════════════════════════
// General / auth
// ════════════════════════════════════════════════════════════

server.tool(
  "validate_api_key",
  "Validate the configured Kinsta API key (the 'login'/whoami check). Returns key details including expiry if valid.",
  {},
  () => run(async () => ok(pretty(await client.request("GET", "/validate")))),
);

server.tool(
  "list_regions",
  "List the data-center regions available to the company.",
  { ...companyParam },
  ({ company_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/company/${client.resolveCompany(company_id)}/available-regions`))),
    ),
);

server.tool(
  "list_company_users",
  "List the company's users (id, email, name, profile picture).",
  { ...companyParam },
  ({ company_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/company/${client.resolveCompany(company_id)}/users`))),
    ),
);

server.tool(
  "list_api_keys",
  "List the company's API keys.",
  { ...companyParam },
  ({ company_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/company/${client.resolveCompany(company_id)}/api-keys`))),
    ),
);

server.tool(
  "list_activity_logs",
  "List company activity logs, with optional filters.",
  {
    ...companyParam,
    limit: z.number().optional(),
    offset: z.number().optional(),
    category: z
      .enum([
        "siteActions",
        "kinstaDns",
        "migrations",
        "billing",
        "notifications",
        "userManagement",
        "personalSettings",
        "samlSso",
      ])
      .optional(),
    site_id: z.string().optional(),
    id_initiated_by: z.string().optional(),
    id_api_key: z.string().optional(),
    language: z.enum(["da", "de", "en", "es", "fr", "it", "ja", "nl", "pt", "sv"]).optional(),
  },
  ({ company_id, ...query }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", `/company/${client.resolveCompany(company_id)}/activity-logs`, {
            query,
          }),
        ),
      ),
    ),
);

// ════════════════════════════════════════════════════════════
// WordPress Sites
// ════════════════════════════════════════════════════════════

server.tool(
  "list_sites",
  "List the company's WordPress sites.",
  {
    ...companyParam,
    include_environments: z.boolean().optional().describe("Include each site's environments."),
  },
  ({ company_id, include_environments }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", "/sites", {
            query: { company: client.resolveCompany(company_id), include_environments },
          }),
        ),
      ),
    ),
);

server.tool(
  "find_site",
  "Find a site and its environment ids by name, display name, label, or domain. " +
    "Typo- and word-order-tolerant: a half-remembered name like \"acme workware\" still " +
    "finds the site \"ACME - Workspace\". START HERE to get the site_id / env_id that other " +
    "tools need — list_sites returns the full untrimmed payload and is far too large to read " +
    "on a big account. Omit `query` to list every site compactly.",
  {
    ...companyParam,
    query: z
      .string()
      .optional()
      .describe(
        "Site name, display name, label, domain, or a site/environment id. Multi-word and misspelled queries are fine.",
      ),
    include_environments: z
      .boolean()
      .optional()
      .describe(
        "Include environments. Defaults to true for a search (the env ids are the point) " +
          "and false when listing every site (they'd swamp the output).",
      ),
    limit: z.number().optional().describe("Max sites to return (default 10)."),
  },
  ({ company_id, query, include_environments, limit }) =>
    run(async () => {
      const q = query?.trim() ?? "";
      const withEnvs = include_environments ?? q !== "";
      const max = limit ?? 10;
      const sites = await client.listSites(company_id);

      if (!q) {
        return ok(
          pretty({
            total: sites.length,
            hint: "Pass `query` to search by name, label or domain and get environment ids back.",
            sites: sites.map((s) => compactSite(s, withEnvs)),
          }),
        );
      }

      const { matched, suggestions } = searchSites(sites, q);

      if (matched.length) {
        return ok(
          pretty({
            query,
            matched: matched.length,
            sites: matched.slice(0, max).map(({ site, score }) => ({
              score: round2(score),
              ...compactSite(site, withEnvs),
            })),
          }),
        );
      }

      if (!suggestions.length) {
        return ok(
          pretty({
            query,
            matched: 0,
            note: `Nothing in this company resembles "${query}". Call find_site with no query to see every site.`,
            sites: [],
          }),
        );
      }

      // Below the match threshold, the top hit is a guess — say so, and make the
      // agent confirm rather than act on it.
      return ok(
        pretty({
          query,
          matched: 0,
          note:
            `No confident match for "${query}". These are the closest sites, best first — ` +
            `confirm which one is meant before acting on it.`,
          did_you_mean: suggestions.slice(0, 5).map(({ site, score }) => ({
            score: round2(score),
            ...compactSite(site, withEnvs),
          })),
        }),
      );
    }),
);

server.tool(
  "get_site",
  "Get a single site by ID.",
  { site_id: z.string() },
  ({ site_id }) => run(async () => ok(pretty(await client.request("GET", `/sites/${site_id}`)))),
);

server.tool(
  "create_site",
  "Create a new WordPress site (async; returns an operation_id). Installs WordPress.",
  {
    ...companyParam,
    display_name: z.string(),
    region: z.string().describe("Region/data-center code (see list_regions)."),
    install_mode: z.enum(["new", "plain", "clone"]).default("new"),
    admin_email: z.string(),
    admin_password: z.string(),
    admin_user: z.string(),
    site_title: z.string(),
    wp_language: z.string().describe("e.g. en_US"),
    is_multisite: z.boolean().optional(),
    is_subdomain_multisite: z.boolean().optional(),
    woocommerce: z.boolean().optional(),
    wordpressseo: z.boolean().optional(),
  },
  ({ company_id, ...rest }) =>
    run(async () => {
      const body = { company: client.resolveCompany(company_id), ...rest };
      return formatResult(await client.request("POST", "/sites", { body, isCreation: true }), "site creation");
    }),
);

server.tool(
  "create_plain_site",
  "Create a plain site (empty environment, no WordPress installed). Async; returns operation_id.",
  { ...companyParam, display_name: z.string(), region: z.string() },
  ({ company_id, ...rest }) =>
    run(async () => {
      const body = { company: client.resolveCompany(company_id), ...rest };
      return formatResult(await client.request("POST", "/sites/plain", { body, isCreation: true }), "plain site creation");
    }),
);

server.tool(
  "clone_site",
  "Clone an existing site environment into a new site. Async; returns operation_id.",
  {
    ...companyParam,
    display_name: z.string(),
    source_env_id: z.string().describe("Environment ID to clone from."),
  },
  ({ company_id, ...rest }) =>
    run(async () => {
      const body = { company: client.resolveCompany(company_id), ...rest };
      return formatResult(await client.request("POST", "/sites/clone", { body, isCreation: true }), "site clone");
    }),
);

server.tool(
  "delete_site",
  "⚠️ DESTRUCTIVE: permanently delete a WordPress site and all its environments. Accepts the site NAME or id. Requires a verbatim user authorization typed in chat (the server reads the transcript to verify it).",
  { site: z.string().describe("Site name or id."), ...companyParam },
  ({ site, company_id }) =>
    run(async () => {
      const t = await siteTarget(site, company_id);
      const blocked = requireAuthorization("delete", t.label);
      if (blocked) return blocked;
      return formatResult(await client.request("DELETE", `/sites/${t.id}`), "site deletion");
    }),
);

server.tool(
  "reset_site",
  "⚠️ DESTRUCTIVE: reset a site to a clean WordPress install, wiping current content. Accepts the site NAME or id. Requires a verbatim user authorization typed in chat.",
  {
    site: z.string().describe("Site name or id."),
    admin_password: z.string().describe("New WP admin password for the reset site."),
    ...companyParam,
  },
  ({ site, admin_password, company_id }) =>
    run(async () => {
      const t = await siteTarget(site, company_id);
      const blocked = requireAuthorization("reset", t.label);
      if (blocked) return blocked;
      return formatResult(
        await client.request("POST", `/sites/${t.id}/reset-site`, { body: { admin_password } }),
        "site reset",
      );
    }),
);

// ════════════════════════════════════════════════════════════
// WordPress Site Environments
// ════════════════════════════════════════════════════════════

server.tool(
  "list_environments",
  "List a site's environments (live, staging, premium staging). Use this to find env_id values.",
  { site_id: z.string() },
  ({ site_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/${site_id}/environments`)))),
);

server.tool(
  "create_environment",
  "Create a new WordPress environment on a site. Async; returns operation_id.",
  {
    site_id: z.string(),
    display_name: z.string(),
    site_title: z.string(),
    is_premium: z.boolean().describe("Premium staging environment."),
    admin_email: z.string(),
    admin_password: z.string(),
    admin_user: z.string(),
    wp_language: z.string(),
    is_multisite: z.boolean().optional(),
    is_subdomain_multisite: z.boolean().optional(),
    woocommerce: z.boolean().optional(),
    wordpress_plugin_edd: z.boolean().optional(),
    wordpressseo: z.boolean().optional(),
  },
  ({ site_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/${site_id}/environments`, { body, isCreation: true }),
        "environment creation",
      ),
    ),
);

server.tool(
  "create_plain_environment",
  "Create a plain environment (no WordPress) on a site. Async; returns operation_id.",
  { site_id: z.string(), display_name: z.string(), is_premium: z.boolean() },
  ({ site_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/${site_id}/environments/plain`, { body, isCreation: true }),
        "plain environment creation",
      ),
    ),
);

server.tool(
  "clone_environment",
  "Clone an existing environment into a new environment on the same site. Async; returns operation_id.",
  {
    site_id: z.string(),
    display_name: z.string(),
    is_premium: z.boolean(),
    source_env_id: z.string(),
  },
  ({ site_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/${site_id}/environments/clone`, { body, isCreation: true }),
        "environment clone",
      ),
    ),
);

server.tool(
  "push_environment",
  "⚠️ DESTRUCTIVE: push (deploy) one environment onto another, OVERWRITING the target's db and/or files. Accepts environment NAMES or ids (scoped to the site). Requires a verbatim user authorization typed in chat.",
  {
    site: z.string().describe("Site name or id."),
    source_environment: z.string().describe("Source environment name or id."),
    target_environment: z.string().describe("Target environment name or id (will be overwritten)."),
    push_db: z.boolean().optional(),
    push_files: z.boolean().optional(),
    run_search_and_replace: z.boolean().optional(),
    push_files_option: z.enum(["ALL_FILES", "SPECIFIC_FILES"]).optional(),
    file_list: z.array(z.string()).optional(),
    ...companyParam,
  },
  ({ site, source_environment, target_environment, company_id, ...rest }) =>
    run(async () => {
      const s = await client.resolveSite(site, company_id);
      const envs = await client.getSiteEnvironments(s.id);
      const src = client.findEnvironment(envs, source_environment);
      if (!src) throw new KinstaError(`No environment matching "${source_environment}" in site "${s.display_name}".`, 404, null);
      const tgt = client.findEnvironment(envs, target_environment);
      if (!tgt) throw new KinstaError(`No environment matching "${target_environment}" in site "${s.display_name}".`, 404, null);
      const label = `the "${tgt.display_name}" environment of site "${s.display_name}" (overwriting it from "${src.display_name}")`;
      const blocked = requireAuthorization("push and overwrite", label);
      if (blocked) return blocked;
      const body = { source_env_id: src.id, target_env_id: tgt.id, ...rest };
      return formatResult(
        await client.request("PUT", `/sites/${s.id}/environments`, { body }),
        "environment push",
      );
    }),
);

server.tool(
  "delete_environment",
  "⚠️ DESTRUCTIVE: permanently delete an environment. Accepts the environment NAME or id (pass `site` to disambiguate by name). Requires a verbatim user authorization typed in chat.",
  {
    environment: z.string().describe("Environment name or id."),
    site: z.string().optional().describe("Site name or id, to disambiguate the environment by name."),
    ...companyParam,
  },
  ({ environment, site, company_id }) =>
    run(async () => {
      const t = await envTarget(environment, site, company_id);
      const blocked = requireAuthorization("delete", t.label);
      if (blocked) return blocked;
      return formatResult(await client.request("DELETE", `/sites/environments/${t.id}`), "environment deletion");
    }),
);

server.tool(
  "change_webroot",
  "Change an environment's webroot subfolder appended to /public. Pass an empty string to revert to default.",
  {
    env_id: z.string(),
    web_root_subfolder: z.string(),
    clear_all_cache: z.boolean().optional(),
    refresh_plugins_and_themes: z.boolean().optional(),
  },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/change-webroot-subfolder`, { body }),
        "webroot change",
      ),
    ),
);

server.tool(
  "change_environment_php_allocation",
  "Change PHP thread count/memory for a PREMIUM STAGING environment. (Not available on Single 1.25M+, WP 60+, Agency, or custom plans.)",
  { env_id: z.string(), thread_count: z.number(), thread_memory: z.number() },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/change-environment-php-allocation`, { body }),
        "PHP allocation change",
      ),
    ),
);

server.tool(
  "change_site_php_allocation",
  "Change PHP memory for a site's LIVE and standard staging environments. (Standard staging always has 2 threads.)",
  { site_id: z.string(), thread_count: z.number(), thread_memory: z.number() },
  ({ site_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/${site_id}/change-site-php-allocation`, { body }),
        "PHP allocation change",
      ),
    ),
);

server.tool(
  "check_wp_admin_exists",
  "Check whether a WP admin user with the given email exists in the environment.",
  { env_id: z.string(), email: z.string() },
  ({ env_id, email }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", `/sites/environments/${env_id}/wpa-user-exists`, { query: { email } }),
        ),
      ),
    ),
);

server.tool(
  "create_wp_admin",
  "Create a WP admin user in the environment.",
  { env_id: z.string(), email: z.string(), first_name: z.string(), last_name: z.string() },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/wpa-create-user`, { body }),
        "WP admin creation",
      ),
    ),
);

server.tool(
  "get_wp_admin_login",
  "Get a one-time WP admin login link for a user by email.",
  { env_id: z.string(), email: z.string() },
  ({ env_id, email }) =>
    run(async () =>
      ok(pretty(await client.request("POST", `/sites/environments/${env_id}/wpa-login-url`, { body: { email } }))),
    ),
);

server.tool(
  "get_environment_files",
  "List files for an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/environments/${env_id}/file-list`)))),
);

// ════════════════════════════════════════════════════════════
// WordPress Site Tools (PHP, cache, denied IPs)
// ════════════════════════════════════════════════════════════

server.tool(
  "change_php_version",
  "Modify an environment's PHP version.",
  {
    environment_id: z.string(),
    php_version: z.string().describe("e.g. 8.2"),
    is_opt_out_from_automatic_php_update: z.boolean().optional(),
  },
  (body) =>
    run(async () =>
      formatResult(await client.request("PUT", "/sites/tools/modify-php-version", { body }), "PHP version change"),
    ),
);

server.tool(
  "restart_php",
  "Restart an environment's PHP engine.",
  { environment_id: z.string() },
  (body) =>
    run(async () =>
      formatResult(await client.request("POST", "/sites/tools/restart-php", { body }), "PHP restart"),
    ),
);

server.tool(
  "run_wp_cli",
  "Run a WP-CLI command on an environment (accepts the environment NAME or id; pass `site` to disambiguate). Powerful: commands like `db reset`, `db drop`, `site empty`, or queries containing DROP/DELETE/TRUNCATE are DESTRUCTIVE and require a verbatim user authorization typed in chat.",
  {
    environment: z.string().describe("Environment name or id."),
    wp_command: z
      .string()
      .describe(
        "The full wp-cli command INCLUDING the leading `wp`, e.g. 'wp plugin list'. " +
          "Kinsta requires the `wp ` prefix and rejects commands without it. Allowed " +
          "characters are restricted to `^wp\\s+[a-zA-Z0-9_\\-./:=@'\\s]+$` — letters, " +
          "digits, space, and ' _ - . / : = @ (so `@` in emails is fine, but `!`, `?`, " +
          "`#`, `$`, etc. are rejected; keep generated passwords to [A-Za-z0-9._:=-]). " +
          "Runs asynchronously: returns an operation_id, and the command's stdout comes " +
          "back in the completion event's `body.data.result`.",
      ),
    site: z.string().optional().describe("Site name or id, to disambiguate the environment by name."),
    ...companyParam,
  },
  ({ environment, wp_command, site, company_id }) =>
    run(async () => {
      const destructive = /\b(db\s+(reset|drop)|site\s+empty|db\s+query[\s\S]*\b(drop|delete|truncate)\b|(plugin|theme)\s+delete)\b/i.test(
        wp_command,
      );
      let envId = environment;
      if (destructive) {
        const t = await envTarget(environment, site, company_id);
        envId = t.id;
        const blocked = requireAuthorization(
          "run a destructive WP-CLI command on",
          `${t.label} (command: ${wp_command})`,
        );
        if (blocked) return blocked;
      } else if (!isUuid(environment)) {
        envId = (await envTarget(environment, site, company_id)).id;
      }
      return formatResult(
        await client.request("POST", `/sites/environments/${envId}/run-wp-cli-command`, { body: { wp_command } }),
        "WP-CLI command",
      );
    }),
);

server.tool(
  "generate_phpmyadmin_login",
  "Generate a phpMyAdmin login link for an environment's database.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () =>
      ok(pretty(await client.request("POST", `/sites/environments/${env_id}/pma-login-token`))),
    ),
);

// ════════════════════════════════════════════════════════════
// SFTP / SSH
// ════════════════════════════════════════════════════════════

server.tool(
  "get_sftp_ssh_config",
  "Get SFTP/SSH connection config (host, port, username) for an environment.",
  { site_id: z.string(), env_id: z.string() },
  ({ site_id, env_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/sites/${site_id}/environments/${env_id}/ssh/config`))),
    ),
);

server.tool(
  "get_sftp_ssh_status",
  "Get SFTP/SSH enabled status for an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/environments/${env_id}/ssh/get-status`)))),
);

server.tool(
  "set_sftp_ssh_status",
  "Enable or disable SFTP/SSH for an environment.",
  { env_id: z.string(), is_enabled: z.boolean() },
  ({ env_id, is_enabled }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/ssh/set-status`, { body: { is_enabled } }),
        "SFTP/SSH status change",
      ),
    ),
);

server.tool(
  "set_sftp_ssh_password_access",
  "Enable or disable SFTP/SSH password access for an environment.",
  { env_id: z.string(), is_enabled: z.boolean() },
  ({ env_id, is_enabled }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/ssh/set-password-status`, {
          body: { is_enabled },
        }),
        "SFTP/SSH password access change",
      ),
    ),
);

server.tool(
  "change_sftp_ssh_password_expiration",
  "Change the SFTP/SSH password expiration interval for an environment.",
  { env_id: z.string(), exp_interval: z.enum(["days_7", "days_30", "days_90", "hours_24", "never"]) },
  ({ env_id, exp_interval }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/ssh/change-expiration-interval`, {
          body: { exp_interval },
        }),
        "SFTP/SSH expiration change",
      ),
    ),
);

server.tool(
  "get_sftp_ssh_password",
  "Get the current SFTP/SSH password for an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/environments/${env_id}/ssh/password`)))),
);

server.tool(
  "generate_sftp_password",
  "Generate a new SFTP/SSH password for an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/ssh/generate-password`),
        "SFTP password generation",
      ),
    ),
);

server.tool(
  "get_sftp_ssh_ip_allowlist",
  "Get the SFTP/SSH IP allowlist for an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/sites/environments/${env_id}/ssh/get-allowed-ips`))),
    ),
);

server.tool(
  "set_sftp_ssh_ip_allowlist",
  "Replace the SFTP/SSH IP allowlist for an environment.",
  { env_id: z.string(), ip_allowlist: z.array(z.string()) },
  ({ env_id, ip_allowlist }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/ssh/set-allowed-ips`, {
          body: { ip_allowlist },
        }),
        "IP allowlist update",
      ),
    ),
);

// ── Additional SFTP users ──
server.tool(
  "list_sftp_users",
  "List additional SFTP accounts for an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/sites/environments/${env_id}/additional-sftp-accounts`))),
    ),
);

server.tool(
  "add_sftp_user",
  "Add an additional SFTP account to an environment.",
  {
    env_id: z.string(),
    username: z.string(),
    password: z.string(),
    root_directory: z.string().optional(),
    permission: z.enum(["read", "write"]).optional(),
  },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/additional-sftp-accounts`, { body }),
        "SFTP user creation",
      ),
    ),
);

server.tool(
  "toggle_sftp_users",
  "Enable or disable additional SFTP accounts for an environment.",
  { env_id: z.string(), enabled: z.boolean() },
  ({ env_id, enabled }) =>
    run(async () =>
      formatResult(
        await client.request("PUT", `/sites/environments/${env_id}/additional-sftp-accounts/toggle-status`, {
          body: { enabled },
        }),
        "SFTP users toggle",
      ),
    ),
);

server.tool(
  "delete_sftp_user",
  "⚠️ DESTRUCTIVE: remove an additional SFTP account. Requires a verbatim user authorization typed in chat.",
  { sftp_account_id: z.string() },
  ({ sftp_account_id }) =>
    run(async () => {
      const blocked = requireAuthorization("delete", `the SFTP account ${sftp_account_id}`);
      if (blocked) return blocked;
      return formatResult(
        await client.request("DELETE", `/sites/environments/additional-sftp-accounts/${sftp_account_id}`),
        "SFTP user deletion",
      );
    }),
);

// ════════════════════════════════════════════════════════════
// Redirect rules
// ════════════════════════════════════════════════════════════

server.tool(
  "get_redirect_rules",
  "Get an environment's redirect rules.",
  {
    env_id: z.string(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    key: z.enum(["domain", "from", "to", "type"]).optional(),
    order: z.enum(["ascend", "descend"]).optional(),
    search_query: z.string().optional(),
    regex_search: z.enum(["true", "false"]).optional(),
  },
  ({ env_id, ...query }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/sites/environments/${env_id}/redirect-rules`, { query }))),
    ),
);

const redirectRuleSchema = z.object({
  domain: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  traffic_from_city: z.string().nullable().optional(),
  traffic_from_country: z.string().nullable().optional(),
  traffic_from_country_name: z.string().nullable().optional(),
  displayed_location: z.string().nullable().optional(),
  type: z.enum(["permanent", "redirect"]),
});

server.tool(
  "update_redirect_rules",
  "Create, update, or delete redirect rules. action_type DELETE/DELETE_ALL is DESTRUCTIVE and requires a verbatim user authorization typed in chat.",
  {
    env_id: z.string(),
    action_type: z.enum(["NEW", "UPDATE", "DELETE", "DELETE_ALL"]),
    rules_to_update: z.array(redirectRuleSchema).optional(),
    new_value: redirectRuleSchema.optional(),
  },
  ({ env_id, ...body }) =>
    run(async () => {
      if (body.action_type === "DELETE" || body.action_type === "DELETE_ALL") {
        const blocked = requireAuthorization(
          `${body.action_type === "DELETE_ALL" ? "delete all redirect rules in" : "delete redirect rules in"}`,
          `environment ${env_id}`,
        );
        if (blocked) return blocked;
      }
      return formatResult(
        await client.request("POST", `/sites/environments/${env_id}/redirect-rules`, { body }),
        "redirect rules update",
      );
    }),
);

// ════════════════════════════════════════════════════════════
// WordPress Site Domains (per environment)
// ════════════════════════════════════════════════════════════

server.tool(
  "list_site_domains",
  "List the domains attached to an environment.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/environments/${env_id}/domains`)))),
);

server.tool(
  "add_site_domain",
  "Add a new domain to an environment.",
  {
    env_id: z.string(),
    domain_name: z.string(),
    is_wildcardless: z.boolean().optional(),
    add_with_www_subdomain: z.boolean().optional(),
    setup_type: z.enum(["quick", "avoid_downtime"]).optional(),
    custom_ssl_key: z.string().optional(),
    custom_ssl_cert: z.string().optional(),
  },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(await client.request("POST", `/sites/environments/${env_id}/domains`, { body }), "domain add"),
    ),
);

server.tool(
  "delete_site_domains",
  "⚠️ DESTRUCTIVE: remove one or more domains from an environment (accepts the environment NAME or id; pass `site` to disambiguate). Requires a verbatim user authorization typed in chat.",
  {
    environment: z.string().describe("Environment name or id."),
    domain_ids: z.array(z.string()),
    site: z.string().optional().describe("Site name or id, to disambiguate the environment by name."),
    ...companyParam,
  },
  ({ environment, domain_ids, site, company_id }) =>
    run(async () => {
      const t = await envTarget(environment, site, company_id);
      const blocked = requireAuthorization(
        "delete domains from",
        `${t.label} (domains: ${domain_ids.join(", ")})`,
      );
      if (blocked) return blocked;
      return formatResult(
        await client.request("DELETE", `/sites/environments/${t.id}/domains`, { body: { domain_ids } }),
        "domain deletion",
      );
    }),
);

server.tool(
  "set_primary_domain",
  "Change the primary domain of an environment.",
  { env_id: z.string(), domain_id: z.string(), run_search_and_replace: z.boolean() },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(
        await client.request("PUT", `/sites/environments/${env_id}/change-primary-domain`, { body }),
        "primary domain change",
      ),
    ),
);

server.tool(
  "get_domain_verification_records",
  "Get verification and pointing records for a site domain.",
  { site_domain_id: z.string() },
  ({ site_domain_id }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", `/sites/environments/domains/${site_domain_id}/verification-records`),
        ),
      ),
    ),
);

// ════════════════════════════════════════════════════════════
// Company Domains & DNS (Kinsta DNS)
// ════════════════════════════════════════════════════════════

server.tool(
  "list_domains",
  "List the company's Kinsta DNS domains. Returns domain_id values for DNS record tools.",
  { ...companyParam },
  ({ company_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", "/domains", { query: { company: client.resolveCompany(company_id) } }))),
    ),
);

server.tool(
  "list_dns_records",
  "List DNS records for a domain.",
  { domain_id: z.string() },
  ({ domain_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/domains/${domain_id}/dns-records`)))),
);

server.tool(
  "create_dns_record",
  "Create a DNS record for a domain.",
  {
    domain_id: z.string(),
    type: z.string().describe("Record type, e.g. A, AAAA, CNAME, TXT, MX."),
    name: z.string(),
    ttl: z.number(),
    resource_records: z.array(z.object({ value: z.string() })),
  },
  ({ domain_id, ...body }) =>
    run(async () =>
      formatResult(await client.request("POST", `/domains/${domain_id}/dns-records`, { body }), "DNS record creation"),
    ),
);

server.tool(
  "update_dns_record",
  "Update a DNS record for a domain (add/remove resource records).",
  {
    domain_id: z.string(),
    type: z.string(),
    name: z.string(),
    ttl: z.number().optional(),
    new_resource_records: z.array(z.object({ value: z.string() })).optional(),
    removed_resource_records: z.array(z.object({ value: z.string() })).optional(),
  },
  ({ domain_id, ...body }) =>
    run(async () =>
      formatResult(await client.request("PUT", `/domains/${domain_id}/dns-records`, { body }), "DNS record update"),
    ),
);

server.tool(
  "delete_dns_record",
  "⚠️ DESTRUCTIVE: delete a DNS record. Requires a verbatim user authorization typed in chat.",
  { domain_id: z.string(), type: z.string(), name: z.string() },
  ({ domain_id, type, name }) =>
    run(async () => {
      const blocked = requireAuthorization(
        "delete",
        `the ${type} DNS record "${name}" in domain ${domain_id}`,
      );
      if (blocked) return blocked;
      return formatResult(
        await client.request("DELETE", `/domains/${domain_id}/dns-records`, { body: { type, name } }),
        "DNS record deletion",
      );
    }),
);

// ════════════════════════════════════════════════════════════
// Caching & CDN
// ════════════════════════════════════════════════════════════

server.tool(
  "clear_site_cache",
  "Clear an environment's site (object/page) cache. May be async (returns operation_id).",
  { environment_id: z.string() },
  (body) =>
    run(async () =>
      formatResult(await client.request("POST", "/sites/tools/clear-cache", { body }), "cache clear"),
    ),
);

server.tool(
  "clear_cdn_cache",
  "Clear an environment's CDN cache. May be async (returns operation_id).",
  { environment_id: z.string(), cdn_cache_id: z.string().describe("From the environment details.") },
  (body) =>
    run(async () =>
      formatResult(await client.request("POST", "/sites/cdn/clear-cache", { body }), "CDN cache clear"),
    ),
);

server.tool(
  "update_cdn_image_optimization",
  "Update CDN image optimization for an environment.",
  {
    environment_id: z.string(),
    image_optimization_type: z
      .enum(["lossy", "lossless", "disable"])
      .describe("'lossy' or 'lossless', or 'disable' to turn image optimization off."),
  },
  ({ environment_id, image_optimization_type }) =>
    run(async () => {
      const body = {
        environment_id,
        image_optimization_type: image_optimization_type === "disable" ? false : image_optimization_type,
      };
      return formatResult(
        await client.request("PUT", "/sites/cdn/image-optimization", { body }),
        "CDN image optimization",
      );
    }),
);

server.tool(
  "clear_edge_cache",
  "Clear an environment's edge cache (Cloudflare). May be async.",
  {
    environment_id: z.string(),
    clear_subdirectories: z.boolean().optional(),
    url: z.string().optional().describe("Clear a specific URL only."),
  },
  (body) =>
    run(async () =>
      formatResult(await client.request("POST", "/sites/edge-caching/clear", { body }), "edge cache clear"),
    ),
);

server.tool(
  "update_edge_cache_status",
  "Enable or disable edge caching for an environment. May be async.",
  { environment_id: z.string(), enabled: z.boolean() },
  (body) =>
    run(async () =>
      formatResult(await client.request("PUT", "/sites/edge-caching/status", { body }), "edge cache status change"),
    ),
);

server.tool(
  "purge_all_caches",
  "Clear every cache an environment has (site, edge, CDN) in one call. Use this instead of " +
    "`wp kinsta cache purge --all`, which the Kinsta API rejects as a WP-CLI command. Accepts the " +
    "environment NAME or id; pass `site` to disambiguate. Skips the edge or CDN cache when the " +
    "environment doesn't have one (e.g. most staging environments).",
  {
    environment: z.string().describe("Environment name or id."),
    site: z.string().optional().describe("Site name or id, to disambiguate the environment by name."),
    ...companyParam,
  },
  ({ environment, site, company_id }) =>
    run(async () => {
      const e = await client.resolveEnvironment(environment, { site, company: company_id });
      // The site list doesn't reliably include the cache ids; the per-site
      // environments endpoint does.
      const full = e.site
        ? ((await client.getSiteEnvironments(e.site.id)).find((x) => x.id === e.id) ?? e)
        : e;
      const label = `the "${e.display_name}" environment of site "${e.site?.display_name ?? site ?? "unknown site"}"`;

      const steps: [string, string | null, () => Promise<any>][] = [
        ["site cache", e.id, () =>
          client.request("POST", "/sites/tools/clear-cache", { body: { environment_id: e.id } })],
        ["edge cache", full.id_edge_cache, () =>
          client.request("POST", "/sites/edge-caching/clear", { body: { environment_id: e.id } })],
        ["CDN cache", full.cdn_cache_id, () =>
          client.request("POST", "/sites/cdn/clear-cache", {
            body: { environment_id: e.id, cdn_cache_id: full.cdn_cache_id },
          })],
      ];

      const lines = [`Cache purge for ${label}:`];
      let failed = false;
      for (const [name, id, call] of steps) {
        if (!id) {
          lines.push(`- ${name}: skipped, the environment has no ${name}.`);
          continue;
        }
        try {
          const data = await call();
          const opId = findOperationId(data);
          lines.push(`- ${name}: ${opId ? `started (operation_id ${opId})` : "cleared"}.`);
        } catch (err) {
          failed = true;
          const msg = err instanceof KinstaError ? err.message : String(err);
          lines.push(`- ${name}: FAILED: ${msg}`);
        }
      }
      lines.push("", "Check a started clear with get_operation and its operation_id.");
      return failed ? fail(lines.join("\n")) : ok(lines.join("\n"));
    }),
);

// ════════════════════════════════════════════════════════════
// Security — denied IPs
// ════════════════════════════════════════════════════════════

server.tool(
  "get_denied_ips",
  "Get the denied (blocked) IP list for an environment.",
  { environment_id: z.string() },
  ({ environment_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", "/sites/tools/denied-ips", { query: { environment_id } }))),
    ),
);

server.tool(
  "update_denied_ips",
  "Replace the denied (blocked) IP list for an environment.",
  { environment_id: z.string(), ip_list: z.array(z.string()) },
  (body) =>
    run(async () =>
      formatResult(await client.request("PUT", "/sites/tools/denied-ips", { body }), "denied IP update"),
    ),
);

// ════════════════════════════════════════════════════════════
// Plugins & Themes
// ════════════════════════════════════════════════════════════

server.tool(
  "list_site_plugins",
  "List an environment's WordPress plugins, optionally filtered.",
  {
    env_id: z.string(),
    status: z.enum(["active", "inactive"]).optional(),
    column: z.enum(["vulnerable", "updatesAvailable"]).optional(),
  },
  ({ env_id, ...query }) =>
    run(async () =>
      // GET-with-body in the spec → sent as query (fetch forbids GET bodies).
      ok(pretty(await client.request("GET", `/sites/environments/${env_id}/wp-plugins`, { query }))),
    ),
);

server.tool(
  "update_site_plugin",
  "Update a single WordPress plugin to a target version.",
  { env_id: z.string(), name: z.string(), update_version: z.string() },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(await client.request("PUT", `/sites/environments/${env_id}/plugins`, { body }), "plugin update"),
    ),
);

server.tool(
  "bulk_update_site_plugins",
  "Bulk-update multiple WordPress plugins.",
  { env_id: z.string(), plugins: z.array(z.object({ name: z.string() })) },
  ({ env_id, plugins }) =>
    run(async () =>
      formatResult(
        await client.request("PUT", `/sites/environments/${env_id}/plugins/bulk-update`, { body: { plugins } }),
        "bulk plugin update",
      ),
    ),
);

server.tool(
  "list_site_themes",
  "List an environment's WordPress themes, optionally filtered.",
  {
    env_id: z.string(),
    status: z.enum(["active", "inactive"]).optional(),
    column: z.enum(["vulnerable", "updatesAvailable"]).optional(),
  },
  ({ env_id, ...query }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/sites/environments/${env_id}/wp-themes`, { query }))),
    ),
);

server.tool(
  "update_site_theme",
  "Update a single WordPress theme to a target version.",
  { env_id: z.string(), name: z.string(), update_version: z.string() },
  ({ env_id, ...body }) =>
    run(async () =>
      formatResult(await client.request("PUT", `/sites/environments/${env_id}/themes`, { body }), "theme update"),
    ),
);

server.tool(
  "bulk_update_site_themes",
  "Bulk-update multiple WordPress themes.",
  { env_id: z.string(), themes: z.array(z.object({ name: z.string() })) },
  ({ env_id, themes }) =>
    run(async () =>
      formatResult(
        await client.request("PUT", `/sites/environments/${env_id}/themes/bulk-update`, { body: { themes } }),
        "bulk theme update",
      ),
    ),
);

server.tool(
  "list_company_plugins",
  "List all plugins across the company's sites, optionally filtered.",
  {
    ...companyParam,
    offset: z.number().optional(),
    limit: z.number().optional(),
    search: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    column: z.enum(["vulnerable", "updatesAvailable"]).optional(),
  },
  ({ company_id, ...query }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", `/company/${client.resolveCompany(company_id)}/wp-plugins`, { query }),
        ),
      ),
    ),
);

server.tool(
  "list_company_themes",
  "List all themes across the company's sites, optionally filtered.",
  {
    ...companyParam,
    offset: z.number().optional(),
    limit: z.number().optional(),
    search: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    column: z.enum(["vulnerable", "updatesAvailable"]).optional(),
  },
  ({ company_id, ...query }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", `/company/${client.resolveCompany(company_id)}/wp-themes`, { query }),
        ),
      ),
    ),
);

// ════════════════════════════════════════════════════════════
// Backups
// ════════════════════════════════════════════════════════════

server.tool(
  "list_backups",
  "List an environment's backups (manual, scheduled, system).",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/environments/${env_id}/backups`)))),
);

server.tool(
  "list_downloadable_backups",
  "List an environment's downloadable backups.",
  { env_id: z.string() },
  ({ env_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/sites/environments/${env_id}/downloadable-backups`))),
    ),
);

server.tool(
  "create_manual_backup",
  "Create a manual backup of an environment. May be async (returns operation_id).",
  { env_id: z.string(), tag: z.string().optional().describe("Optional label for the backup.") },
  ({ env_id, tag }) =>
    run(async () =>
      formatResult(
        await client.request("POST", `/sites/environments/${env_id}/manual-backups`, { body: { tag } }),
        "manual backup",
      ),
    ),
);

server.tool(
  "restore_backup",
  "⚠️ DESTRUCTIVE: restore a backup ONTO an environment, OVERWRITING its current state. Accepts the target environment NAME or id (pass `site` to disambiguate). Async. Requires a verbatim user authorization typed in chat.",
  {
    environment: z.string().describe("Target environment name or id (will be overwritten)."),
    backup_id: z.number(),
    notified_user_id: z.string().describe("User ID to notify (see list_company_users)."),
    site: z.string().optional().describe("Site name or id, to disambiguate the environment by name."),
    ...companyParam,
  },
  ({ environment, backup_id, notified_user_id, site, company_id }) =>
    run(async () => {
      const t = await envTarget(environment, site, company_id);
      const blocked = requireAuthorization(
        "restore a backup over",
        `${t.label} (restoring backup ${backup_id} over it)`,
      );
      if (blocked) return blocked;
      return formatResult(
        await client.request("POST", `/sites/environments/${t.id}/backups/restore`, {
          body: { backup_id, notified_user_id },
        }),
        "backup restore",
      );
    }),
);

server.tool(
  "delete_backup",
  "⚠️ DESTRUCTIVE: permanently delete an environment backup. Requires a verbatim user authorization typed in chat.",
  { backup_id: z.number() },
  ({ backup_id }) =>
    run(async () => {
      const blocked = requireAuthorization("delete", `backup ${backup_id}`);
      if (blocked) return blocked;
      return formatResult(
        await client.request("DELETE", `/sites/environments/backups/${backup_id}`),
        "backup deletion",
      );
    }),
);

// ════════════════════════════════════════════════════════════
// Logs
// ════════════════════════════════════════════════════════════

server.tool(
  "get_site_logs",
  "Get an environment's log file (error, access, or kinsta-cache-perf). Rate-limited to 35/min by Kinsta.",
  {
    env_id: z.string(),
    file_name: z.enum(["error", "access", "kinsta-cache-perf"]),
    lines: z.number().describe("Number of lines to return."),
  },
  ({ env_id, file_name, lines }) =>
    run(async () =>
      ok(
        pretty(
          await client.request("GET", `/sites/environments/${env_id}/logs`, {
            query: { file_name, lines },
          }),
        ),
      ),
    ),
);

// ════════════════════════════════════════════════════════════
// Analytics
// ════════════════════════════════════════════════════════════

const TIME_SPANS = ["24_hours", "7_days", "30_days", "60_days"] as const;

interface AnalyticsDef {
  name: string;
  pathSeg: string;
  desc: string;
  spans: readonly string[];
  timeZone?: boolean;
}
const analyticsEndpoints: AnalyticsDef[] = [
  { name: "get_analytics_visits", pathSeg: "visits", desc: "visits", spans: TIME_SPANS },
  { name: "get_analytics_visits_dispersion", pathSeg: "visits-dispersion", desc: "visits dispersion", spans: TIME_SPANS },
  { name: "get_analytics_bandwidth", pathSeg: "bandwidth", desc: "server bandwidth", spans: TIME_SPANS },
  { name: "get_analytics_cdn_bandwidth", pathSeg: "cdn-bandwidth", desc: "CDN bandwidth", spans: TIME_SPANS },
  { name: "get_analytics_response_codes", pathSeg: "response-codes", desc: "response code breakdown", spans: TIME_SPANS },
  { name: "get_analytics_top_cities", pathSeg: "top-cities", desc: "top cities", spans: TIME_SPANS },
  { name: "get_analytics_top_countries", pathSeg: "top-countries", desc: "top countries", spans: TIME_SPANS },
  { name: "get_analytics_top_client_ips", pathSeg: "top-client-ips", desc: "top client IPs", spans: TIME_SPANS },
  { name: "get_analytics_disk_space", pathSeg: "diskspace", desc: "disk space", spans: ["7_days", "30_days", "60_days"], timeZone: true },
];

for (const a of analyticsEndpoints) {
  const shape: Record<string, z.ZodTypeAny> = {
    env_id: z.string(),
    company_id: z.string().optional().describe("Defaults to KINSTA_COMPANY_ID."),
    time_span: z.enum(a.spans as [string, ...string[]]).optional(),
    from: z.string().optional().describe("ISO start (use with `to` for a custom range)."),
    to: z.string().optional().describe("ISO end."),
  };
  if (a.timeZone) shape.time_zone = z.string().describe("IANA time zone, e.g. America/New_York.");
  server.tool(a.name, `Get ${a.desc} analytics for an environment.`, shape, (params: any) =>
    run(async () => {
      const { env_id, company_id, ...query } = params;
      (query as any).company_id = client.resolveCompany(company_id);
      return ok(
        pretty(await client.request("GET", `/sites/environments/${env_id}/analytics/${a.pathSeg}`, { query })),
      );
    }),
  );
}

// Monthly usage (site-scoped, no params beyond site_id)
const usageEndpoints: { name: string; seg: string; desc: string }[] = [
  { name: "get_visits_usage", seg: "visits", desc: "visits" },
  { name: "get_bandwidth_usage", seg: "bandwidth", desc: "server bandwidth" },
  { name: "get_cdn_bandwidth_usage", seg: "cdn-bandwidth", desc: "CDN bandwidth" },
];
for (const u of usageEndpoints) {
  server.tool(u.name, `Get this-month ${u.desc} usage for a site.`, { site_id: z.string() }, ({ site_id }) =>
    run(async () => ok(pretty(await client.request("GET", `/sites/${site_id}/usage/${u.seg}/this-month`)))),
  );
}

// ════════════════════════════════════════════════════════════
// Operations / async helpers
// ════════════════════════════════════════════════════════════

server.tool(
  "get_operation",
  "Check the status of an async operation by operation_id (returned by create/clone/reset/restore/cache tools).",
  { operation_id: z.string() },
  ({ operation_id }) =>
    run(async () =>
      ok(pretty(await client.request("GET", `/operations/${encodeURIComponent(operation_id)}`))),
    ),
);

server.tool(
  "operation_monitor_instructions",
  "Get a ready-to-run Monitor command that watches an operation_id to completion. Pass the returned `command` to Claude Code's Monitor tool (each stdout line is a JSON status event; it exits when the op finishes or fails).",
  {
    operation_id: z.string(),
    interval_seconds: z.number().optional().describe("Poll interval (default 10)."),
    timeout_seconds: z.number().optional().describe("Give up after this many seconds (default 600)."),
  },
  ({ operation_id, interval_seconds, timeout_seconds }) => {
    let command = monitorCommand(operation_id);
    if (interval_seconds) command += ` --interval ${interval_seconds}`;
    if (timeout_seconds) command += ` --timeout ${timeout_seconds}`;
    const monitor = {
      command,
      description: `Kinsta operation ${operation_id}`,
      persistent: false,
      timeout_ms: (timeout_seconds ?? 600) * 1000 + 30_000,
    };
    return ok(
      JSON.stringify(
        {
          monitor,
          notes: [
            "Pass `monitor.command` to the Monitor tool (set its description/timeout_ms from this object).",
            "Each stdout line is a JSON event: progress / completed / failed / initializing / timeout.",
            "It exits on any terminal state so silence never masquerades as success.",
            "Alternatively call get_operation once with this operation_id.",
          ],
        },
        null,
        2,
      ),
    );
  },
);

// ── Start ───────────────────────────────────────────────────
async function main() {
  if (CLI_MODE) {
    // No transcript to read outside an MCP session: destructive tools ask on
    // the terminal instead, and refuse when there isn't one.
    setAuthorizationMode("tty");
    process.exit(await runCli(CLI_ARGS, TOOLS));
  }
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

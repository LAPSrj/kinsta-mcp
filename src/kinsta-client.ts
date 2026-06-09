const BASE_URL = "https://api.kinsta.com/v2";

const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_CREATION_PER_MINUTE = 5;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

export interface KinstaConfig {
  apiKey: string;
  companyId?: string;
  /** Max concurrent non-creation requests (default 5). */
  maxConcurrency?: number;
  /** Max creation requests per rolling minute (Kinsta caps at 5; default 5). */
  creationPerMinute?: number;
  /** Max ms to wait on a 429 retry before erroring out (default 30000). */
  maxRetryDelayMs?: number;
  /** Max retries on 429 (default 3). */
  maxRetries?: number;
}

// ── Simple promise-based semaphore ──────────────────────────────
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

/** Rolling-window limiter for creation endpoints (Kinsta allows 5/min). */
class CreationLimiter {
  private starts: number[] = [];
  constructor(private perMinute: number) {}
  async acquire(): Promise<void> {
    // Drop a token only after waiting long enough that fewer than perMinute
    // starts occurred in the trailing 60s window.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.starts = this.starts.filter((t) => now - t < 60_000);
      if (this.starts.length < this.perMinute) {
        this.starts.push(now);
        return;
      }
      const waitMs = 60_000 - (now - this.starts[0]) + 50;
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 100)));
    }
  }
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  /** Route through the 5/min creation limiter. */
  isCreation?: boolean;
}

export class KinstaError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "KinstaError";
  }
}

export class KinstaClient {
  private authHeader: string;
  public companyId?: string;
  private semaphore: Semaphore;
  private creationLimiter: CreationLimiter;
  private maxRetryDelayMs: number;
  private maxRetries: number;

  constructor(config: KinstaConfig) {
    this.authHeader = `Bearer ${config.apiKey}`;
    this.companyId = config.companyId;
    this.semaphore = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.creationLimiter = new CreationLimiter(
      config.creationPerMinute ?? DEFAULT_CREATION_PER_MINUTE,
    );
    this.maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Company id for a call: explicit override, else the configured default. */
  resolveCompany(override?: string): string {
    const id = override ?? this.companyId;
    if (!id) {
      throw new KinstaError(
        "No company_id provided and KINSTA_COMPANY_ID is not set. Pass company_id explicitly.",
        400,
        null,
      );
    }
    return id;
  }

  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const date = new Date(header).getTime();
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const url = new URL(BASE_URL + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };

    // fetch forbids a body on GET/HEAD; callers that have GET "body" params
    // must pass them as query instead. Guard against accidental misuse.
    const canHaveBody = method !== "GET" && method !== "HEAD";
    if (opts.body !== undefined && canHaveBody) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    if (opts.isCreation) await this.creationLimiter.acquire();
    await this.semaphore.acquire();
    try {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const res = await fetch(url, init);

        if (res.status !== 429) {
          const text = await res.text();
          let parsed: unknown = undefined;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          if (!res.ok) {
            const msg =
              parsed && typeof parsed === "object" && "message" in parsed
                ? String((parsed as Record<string, unknown>).message)
                : text || res.statusText;
            throw new KinstaError(
              `Kinsta API ${method} ${path} → ${res.status}: ${msg}`,
              res.status,
              parsed,
            );
          }
          if (res.status === 204 || !text) return {} as T;
          return parsed as T;
        }

        // 429 — back off
        const retryAfterMs =
          this.parseRetryAfter(res.headers.get("Retry-After")) ??
          Math.min(1000 * 2 ** attempt, this.maxRetryDelayMs);

        if (retryAfterMs > this.maxRetryDelayMs) {
          const text = await res.text();
          throw new KinstaError(
            `Kinsta API ${method} ${path} → 429: rate limited; retry delay ` +
              `(${Math.ceil(retryAfterMs / 1000)}s) exceeds max ` +
              `(${Math.ceil(this.maxRetryDelayMs / 1000)}s). ${text}`,
            429,
            text,
          );
        }
        lastError = new KinstaError(
          `Kinsta API ${method} ${path} → 429: rate limited (attempt ${attempt + 1}/${this.maxRetries + 1})`,
          429,
          null,
        );
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, retryAfterMs));
        }
      }
      throw lastError!;
    } finally {
      this.semaphore.release();
    }
  }

  // ── Name → id resolution ───────────────────────────────────────
  // Lets tools accept human-friendly site/environment NAMES (or ids) and
  // resolve them to the canonical id + display name. The destructive guard
  // builds its required phrase from the resolved display names, so the human
  // authorizes by name and the agent still cannot forge it.

  async listSites(company?: string, includeEnvironments = false): Promise<any[]> {
    const data = await this.request<any>("GET", "/sites", {
      query: { company: this.resolveCompany(company), include_environments: includeEnvironments },
    });
    return data?.company?.sites ?? [];
  }

  async getSiteEnvironments(siteId: string): Promise<any[]> {
    const data = await this.request<any>("GET", `/sites/${siteId}/environments`);
    return data?.site?.environments ?? [];
  }

  /** Resolve a site by id or by display_name/name (case-insensitive). */
  async resolveSite(identifier: string, company?: string): Promise<SiteRef> {
    const sites = await this.listSites(company, false);
    let m = sites.find((s) => s.id === identifier);
    if (!m) {
      const norm = identifier.trim().toLowerCase();
      const byName = sites.filter(
        (s) => (s.display_name || "").toLowerCase() === norm || (s.name || "").toLowerCase() === norm,
      );
      if (byName.length === 0) {
        throw new KinstaError(
          `No site found matching "${identifier}". Use list_sites to see names and ids.`,
          404,
          null,
        );
      }
      if (byName.length > 1) {
        throw new KinstaError(
          `"${identifier}" matches multiple sites: ${byName
            .map((s) => `${s.display_name} (${s.id})`)
            .join("; ")}. Pass the exact site id.`,
          409,
          null,
        );
      }
      m = byName[0];
    }
    return { id: m.id, name: m.name, display_name: m.display_name };
  }

  /** Match an environment within a list by id or display_name/name. */
  findEnvironment(envs: any[], identifier: string): any | null {
    const byId = envs.find((e) => e.id === identifier);
    if (byId) return byId;
    const norm = identifier.trim().toLowerCase();
    const byName = envs.filter(
      (e) => (e.display_name || "").toLowerCase() === norm || (e.name || "").toLowerCase() === norm,
    );
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new KinstaError(
        `"${identifier}" matches multiple environments: ${byName
          .map((e) => `${e.display_name} (${e.id})`)
          .join("; ")}. Pass the exact environment id.`,
        409,
        null,
      );
    }
    return null;
  }

  private toEnvRef(e: any, s: any): EnvRef {
    return {
      id: e.id,
      name: e.name,
      display_name: e.display_name,
      is_premium: e.is_premium,
      cdn_cache_id: e.cdn_cache_id,
      id_edge_cache: e.id_edge_cache,
      site: s ? { id: s.id, name: s.name, display_name: s.display_name } : null,
    };
  }

  /**
   * Resolve an environment by id or name. If `site` is given, scope to that
   * site; otherwise scan all sites and require the name/id to be unambiguous.
   */
  async resolveEnvironment(
    identifier: string,
    opts: { site?: string; company?: string } = {},
  ): Promise<EnvRef> {
    if (opts.site) {
      const s = await this.resolveSite(opts.site, opts.company);
      const envs = await this.getSiteEnvironments(s.id);
      const e = this.findEnvironment(envs, identifier);
      if (!e) {
        throw new KinstaError(
          `No environment matching "${identifier}" in site "${s.display_name}". Use list_environments.`,
          404,
          null,
        );
      }
      return this.toEnvRef(e, s);
    }

    const sites = await this.listSites(opts.company, true);
    const norm = identifier.trim().toLowerCase();
    const matches: { e: any; s: any }[] = [];
    for (const s of sites) {
      for (const e of s.environments ?? []) {
        if (e.id === identifier) return this.toEnvRef(e, s);
        if ((e.display_name || "").toLowerCase() === norm || (e.name || "").toLowerCase() === norm) {
          matches.push({ e, s });
        }
      }
    }
    if (matches.length === 0) {
      throw new KinstaError(
        `No environment found matching "${identifier}" in any site. Pass 'site' to disambiguate, or use list_environments.`,
        404,
        null,
      );
    }
    if (matches.length > 1) {
      throw new KinstaError(
        `"${identifier}" matches environments in multiple sites: ${matches
          .map(({ e, s }) => `${e.display_name} of ${s.display_name} (${e.id})`)
          .join("; ")}. Pass 'site'.`,
        409,
        null,
      );
    }
    return this.toEnvRef(matches[0].e, matches[0].s);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

export interface SiteRef {
  id: string;
  name: string;
  display_name: string;
}
export interface EnvRef {
  id: string;
  name: string;
  display_name: string;
  is_premium?: boolean;
  cdn_cache_id?: string | null;
  id_edge_cache?: string | null;
  site: SiteRef | null;
}

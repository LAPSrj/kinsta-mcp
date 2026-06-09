# Kinsta MCP Server

An MCP (Model Context Protocol) server for managing WordPress sites on
[Kinsta](https://kinsta.com). It wraps the **entire** Kinsta REST API
WordPress-hosting surface (v1.97.0) — sites, environments, domains & DNS,
backups, plugins/themes, caching/CDN, SFTP/SSH, PHP, analytics, logs, and
operations — as **89 tools**, plus general tooling like API-key validation.

Built to mirror the sibling `bugherd-mcp` (Bun + TypeScript + the MCP SDK).

## Features

- **Full 1:1 API coverage** — one tool per Kinsta endpoint.
- **Async-aware** — operations that return `202 + operation_id` come back with the
  id, a one-shot `get_operation` hint, and a ready-to-run **Monitor** command.
- **Hard, self-contained destructive-op guard** — deletes/resets/restores/pushes
  are blocked until the *user* types a verbatim authorization, which the server
  verifies by reading the conversation transcript itself (see below).
- **Rate-limit aware** — honors `Retry-After` on 429s, with a separate
  5-requests/minute lane for resource creation (Kinsta's creation cap).

## Setup

### Prerequisites

- [Bun](https://bun.sh)
- A Kinsta API key — MyKinsta → **Company settings → API Keys**.
- Your company ID — from the MyKinsta URL `…?idCompany=<THIS>`.

### Install & build

```bash
bun install
bun run build
```

### Configure

Copy `.env.example` to `.env` and fill in `KINSTA_API_KEY` and
`KINSTA_COMPANY_ID`, or set them in your MCP client config:

```json
{
  "mcpServers": {
    "kinsta": {
      "command": "bun",
      "args": ["/home/leandro/repos/kinsta-mcp/dist/index.js"],
      "env": {
        "KINSTA_API_KEY": "your-api-key",
        "KINSTA_COMPANY_ID": "your-company-id"
      }
    }
  }
}
```

| Variable | Required | Description |
|---|---|---|
| `KINSTA_API_KEY` | ✅ | Kinsta API key (Bearer token). |
| `KINSTA_COMPANY_ID` | – | Default company for company-scoped tools; every such tool also accepts a per-call `company_id`. |
| `KINSTA_MAX_CONCURRENT_REQUESTS` | – | Default 5. |
| `KINSTA_CREATION_PER_MINUTE` | – | Default 5 (Kinsta's creation cap). |
| `KINSTA_MAX_RETRY_DELAY_MS` | – | Default 30000. |
| `KINSTA_MAX_RETRIES` | – | Default 3. |
| `KINSTA_TRANSCRIPT_DIR` | – | Override the transcript dir the guard reads (defaults to `~/.claude/projects/<encoded-cwd>/`). |

## Async operations & the Monitor

Many Kinsta actions (site/environment create·clone·reset, backup restore, cache
clears, PHP restart, …) are asynchronous: the API returns `202` with an
`operation_id`. Those tools return text like:

```
Started async site creation.
operation_id: sites:add-…
To watch it to completion, pass this to the Monitor tool:
  command: bun /…/scripts/operation-monitor.ts --id sites:add-…
Or check once with the get_operation tool.
```

- **`get_operation`** — check status once by id.
- **`operation_monitor_instructions`** — returns a ready `monitor` object
  (`command` / `description` / `timeout_ms`) to hand to Claude Code's `Monitor`
  tool. `scripts/operation-monitor.ts` polls `/operations/{id}`, emits one JSON
  line per status change, and **exits on any terminal state** (success *or*
  failure) so silence never looks like success. It also tolerates the brief
  `404` window right after a site-creation op starts.

> Claude Code's `Monitor` spawns children with a stripped environment, so the
> monitor can't inherit the server's `KINSTA_API_KEY`. Instead of inlining the
> key (or even a path) on the command line, the server persists the key to
> `~/.config/kinsta-mcp/api-key` (mode `0600`) and the monitor reads it from
> that default location itself — so the command line carries no secret at all.
> This mirrors `gmail-mcp`, which keeps its OAuth tokens on disk rather than on
> the command line, so the secret never lands in `ps`, shell history, or the
> conversation transcript. (`operation-monitor.ts` also honors a `KINSTA_API_KEY`
> env var, or a `KINSTA_API_KEY_FILE` path for a non-default key location.)

## Destructive-operation guard (how it works)

Destructive tools — `delete_site`, `reset_site`, `delete_environment`,
`push_environment`, `restore_backup`, `delete_backup`, `delete_site_domains`,
`delete_dns_record`, `delete_sftp_user`, `update_redirect_rules` (DELETE /
DELETE_ALL), and `run_wp_cli` for destructive commands — are gated by a **hard
barrier enforced inside the server**, not by trusting the assistant.

Destructive site/environment tools accept the **site/environment NAME** (or id)
and resolve it to the id for you — so you never have to dig up UUIDs. The server
builds the authorization phrase from the *canonical resolved display name*, then
refuses and tells you the exact sentence to type, e.g.:

```
I authorize Kinsta to delete the site "My Blog" (id …)
I authorize Kinsta to delete the "Staging" environment of site "My Blog"
```

Type that sentence yourself, then ask again. The server confirms authorization by
**reading the Claude Code transcript JSONL directly** and checking that the
phrase appears in a message *you actually typed*. Because the phrase is built from
the resolved name (not from what the assistant passed), the assistant still can't
forge it — and a name that matches multiple sites/environments is rejected until
you disambiguate (pass `site`, or the exact id).

Why this can't be bypassed by the assistant:

- Your messages are `type:"user"` records with `text` content blocks.
- The assistant's words are `type:"assistant"` records — **excluded**.
- Anything the assistant routes through a tool is a `tool_result` block —
  **dropped**.
- The assistant cannot append a `user` text record or pass the phrase as a
  trusted parameter.

So a match can only come from you typing it. The guard **fails closed**: no
transcript, no match, or a phrase naming a different resource → the action is
refused. The required phrase names the exact action and resource, so an old
"yes go ahead" or an authorization for a different resource won't work.

## Tools

89 tools across: general/auth (`validate_api_key`, `list_regions`,
`list_company_users`, `list_api_keys`, `list_activity_logs`), **sites**
(`list_sites`, `get_site`, `create_site`, `create_plain_site`, `clone_site`,
`delete_site`⚠️, `reset_site`⚠️), **environments** (`list_environments`,
`create_environment`, `create_plain_environment`, `clone_environment`,
`push_environment`⚠️, `delete_environment`⚠️, `change_webroot`,
`change_environment_php_allocation`, `change_site_php_allocation`,
`check_wp_admin_exists`, `create_wp_admin`, `get_wp_admin_login`,
`get_environment_files`), **PHP/tools** (`change_php_version`, `restart_php`,
`run_wp_cli`⚠️, `generate_phpmyadmin_login`), **SFTP/SSH**
(`get_sftp_ssh_config`, `get_sftp_ssh_status`, `set_sftp_ssh_status`,
`set_sftp_ssh_password_access`, `change_sftp_ssh_password_expiration`,
`get_sftp_ssh_password`, `generate_sftp_password`, `get_sftp_ssh_ip_allowlist`,
`set_sftp_ssh_ip_allowlist`, `list_sftp_users`, `add_sftp_user`,
`toggle_sftp_users`, `delete_sftp_user`⚠️), **redirect rules**
(`get_redirect_rules`, `update_redirect_rules`⚠️), **site domains**
(`list_site_domains`, `add_site_domain`, `delete_site_domains`⚠️,
`set_primary_domain`, `get_domain_verification_records`), **DNS**
(`list_domains`, `list_dns_records`, `create_dns_record`, `update_dns_record`,
`delete_dns_record`⚠️), **caching/CDN** (`clear_site_cache`, `clear_cdn_cache`,
`update_cdn_image_optimization`, `clear_edge_cache`, `update_edge_cache_status`),
**security** (`get_denied_ips`, `update_denied_ips`), **plugins/themes**
(`list_site_plugins`, `update_site_plugin`, `bulk_update_site_plugins`,
`list_site_themes`, `update_site_theme`, `bulk_update_site_themes`,
`list_company_plugins`, `list_company_themes`), **backups** (`list_backups`,
`list_downloadable_backups`, `create_manual_backup`, `restore_backup`⚠️,
`delete_backup`⚠️), **logs** (`get_site_logs`), **analytics**
(`get_analytics_visits`, `…_visits_dispersion`, `…_bandwidth`, `…_cdn_bandwidth`,
`…_response_codes`, `…_top_cities`, `…_top_countries`, `…_top_client_ips`,
`…_disk_space`, `get_visits_usage`, `get_bandwidth_usage`,
`get_cdn_bandwidth_usage`), and **operations** (`get_operation`,
`operation_monitor_instructions`).

⚠️ = guarded destructive operation.

## Development

```bash
bun run dev     # run from source
bun test        # auth-guard unit tests (incl. spoof-rejection vectors)
bun run build   # typecheck + emit dist/
```

## API reference

Wraps the [Kinsta API](https://api-docs.kinsta.com) at
`https://api.kinsta.com/v2`. Auth is HTTP Bearer. Rate limits: 120 req/min per
company, 5/min for resource creation, 1000/min per IP.

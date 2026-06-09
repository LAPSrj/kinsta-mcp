#!/usr/bin/env bun
/**
 * Standalone poller for a Kinsta async operation, designed to be driven by
 * Claude Code's `Monitor` tool. Each stdout line is one event. It emits a line
 * on every status change and EXITS on any terminal state (success or failure)
 * so a stalled/failed op can't masquerade as "still running".
 *
 * Usage:
 *   bun scripts/operation-monitor.ts --id <operation_id> [--interval 10] [--timeout 600]
 *
 * Auth: resolves the API key in this order:
 *   1. KINSTA_API_KEY (env) — if present, used directly.
 *   2. KINSTA_API_KEY_FILE (env) — path to a file containing the key.
 *   3. ~/.config/kinsta-mcp/api-key — default on-disk location.
 * Because Monitor spawns children with a stripped env, the instructions tool
 * inlines only the FILE PATH (KINSTA_API_KEY_FILE=...), never the secret —
 * mirroring gmail-mcp, which keeps tokens on disk and inlines only paths. The
 * key therefore never appears on the command line / in ps / in the transcript.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://api.kinsta.com/v2";

function resolveApiKey(): string | undefined {
  if (process.env.KINSTA_API_KEY) return process.env.KINSTA_API_KEY;
  const file =
    process.env.KINSTA_API_KEY_FILE ||
    join(homedir(), ".config", "kinsta-mcp", "api-key");
  try {
    const key = readFileSync(file, "utf8").trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const operationId = arg("--id");
const intervalSec = Number(arg("--interval", "10"));
const timeoutSec = Number(arg("--timeout", "600"));
const apiKey = resolveApiKey();

if (!operationId) {
  console.error("operation-monitor: --id <operation_id> is required");
  process.exit(2);
}
if (!apiKey) {
  console.error(
    "operation-monitor: no API key — set KINSTA_API_KEY, KINSTA_API_KEY_FILE, or write ~/.config/kinsta-mcp/api-key",
  );
  process.exit(2);
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ operation_id: operationId, ...obj }) + "\n");
}

// Treat these substrings (seen in message/status) as terminal.
function classify(message: string, httpStatus: number): "done" | "failed" | "pending" {
  const m = message.toLowerCase();
  if (/(success|finished|completed|done|ready)/.test(m)) return "done";
  if (/(fail|error|cancel|abort|timed out)/.test(m)) return "failed";
  // status 200 with a non-progress message generally means the op resolved.
  if (httpStatus === 200 && !/progress|in progress|pending|running|processing/.test(m)) {
    return "done";
  }
  return "pending";
}

async function poll(): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastMessage = "";
  let notFoundStreak = 0;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/operations/${encodeURIComponent(operationId!)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
    } catch (e) {
      emit({ event: "transient_error", detail: String(e) });
      await sleep(intervalSec);
      continue;
    }

    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw */
    }

    // Site creation can 404 for the first few seconds while the op initializes.
    if (res.status === 404) {
      notFoundStreak++;
      if (notFoundStreak <= 6) {
        emit({ event: "initializing", http: 404 });
        await sleep(intervalSec);
        continue;
      }
      emit({ event: "failed", reason: "operation not found (gave up after initialization window)", http: 404 });
      process.exit(1);
    }
    notFoundStreak = 0;

    if (!res.ok) {
      emit({ event: "http_error", http: res.status, body });
      // Non-terminal HTTP hiccup: keep trying within the window.
      await sleep(intervalSec);
      continue;
    }

    const message =
      (body && typeof body === "object" && (body.message ?? body.data?.message)) || "";
    if (message && message !== lastMessage) {
      emit({ event: "progress", message, http: res.status });
      lastMessage = message;
    }

    const verdict = classify(String(message), res.status);
    if (verdict === "done") {
      emit({ event: "completed", message: String(message), body });
      process.exit(0);
    }
    if (verdict === "failed") {
      emit({ event: "failed", message: String(message), body });
      process.exit(1);
    }

    await sleep(intervalSec);
  }

  emit({ event: "timeout", waited_seconds: timeoutSec });
  process.exit(2);
}

function sleep(sec: number): Promise<void> {
  return new Promise((r) => setTimeout(r, sec * 1000));
}

poll();

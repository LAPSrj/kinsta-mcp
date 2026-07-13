/**
 * Self-contained destructive-operation barrier.
 *
 * The guard verifies that the HUMAN actually authorized a destructive action,
 * without trusting the calling agent (the agent can lie, and any parameter it
 * passes is agent-controlled). It does this by reading this session's Claude
 * Code transcript JSONL directly from disk and checking that a verbatim,
 * resource-specific authorization phrase appears in a genuine user-typed
 * message.
 *
 * Why this is forge-proof: Claude Code appends every turn to
 * `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. A real human message is a
 * record with `type:"user"` whose `message.content[]` holds `{type:"text"}`
 * blocks. The agent's own words are `type:"assistant"` records (excluded), and
 * anything the agent can cause a tool to emit is a `{type:"tool_result"}` block
 * (dropped). The agent has no way to append a `type:"user"` text record, route
 * the phrase through a tool result, or pass it as a trusted parameter. So a
 * match in the user-typed projection can only come from the human typing it.
 *
 * This is a clean-room port of the projection used by pantheon's
 * `validate_user_quote` (extractUserTypedText / stringifyUserTextBlocksOnly).
 * Nothing here imports pantheon — the MCP is fully standalone.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GuardResult {
  authorized: boolean;
  /** The exact sentence the user must type to authorize this action. */
  requiredPhrase: string;
  /** Human-readable reason when not authorized (for the refusal message). */
  reason?: string;
  /** Where we looked, for diagnostics in the refusal message. */
  transcriptDir?: string;
}

/** Replicates Claude Code's project-dir encoding: absolute cwd with every
 * path separator replaced by a dash. Verified against the on-disk dir
 * `-home-leandro-repos-kinsta-mcp` for cwd `/home/leandro/repos/kinsta-mcp`. */
export function encodeCwdForClaudeProject(cwd: string): string {
  const abs = path.resolve(cwd);
  return abs.replace(/\//g, "-");
}

/** Resolve the transcript directory. Honors KINSTA_TRANSCRIPT_DIR, else
 * derives `~/.claude/projects/<encoded-cwd>/` from process.cwd(). */
export function resolveTranscriptDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.KINSTA_TRANSCRIPT_DIR) return env.KINSTA_TRANSCRIPT_DIR;
  const home = env.HOME || os.homedir();
  return path.join(home, ".claude", "projects", encodeCwdForClaudeProject(cwd));
}

/** Build the canonical authorization sentence for an action + resource. */
export function buildPhrase(action: string, resourceLabel: string): string {
  return `I authorize Kinsta to ${action} ${resourceLabel}`;
}

/** Normalize for tolerant matching: lowercase, collapse whitespace, strip
 * surrounding quotes the user might add, trim. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** STRICT user-typed-text projection — only `content[].type === "text"` blocks
 * of `type:"user"` records. Tool_use / tool_result / image / any other block
 * type is dropped so the agent can't spoof a phrase via a tool result. Returns
 * null when the record is not a genuine user-typed message. */
export function extractUserTypedText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (entry.type !== "user") return null;
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === "string") {
    return content.length ? content : null;
  }
  if (!Array.isArray(content)) return null;
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    }
    // tool_use, tool_result, image, etc. intentionally dropped.
  }
  const joined = out.join("\n");
  return joined.length ? joined : null;
}

function readJsonlLines(filePath: string): unknown[] {
  const out: unknown[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export interface VerifyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: read records from here instead of the resolved dir. */
  transcriptDirOverride?: string;
}

/**
 * Where the authorization has to come from.
 *
 * - `transcript` (default, MCP server): read the Claude Code transcript and
 *   look for the phrase in a message the human actually typed.
 * - `tty` (CLI): ask on the controlling terminal and require the human to type
 *   the phrase there. An agent shelling out to the CLI has no controlling
 *   terminal, so it gets the same refusal a piped/CI invocation does — the
 *   "only a human can authorize" property survives the CLI.
 */
export type AuthorizationMode = "transcript" | "tty";

let authorizationMode: AuthorizationMode = "transcript";

export function setAuthorizationMode(mode: AuthorizationMode): void {
  authorizationMode = mode;
}

/**
 * Read one line from the controlling terminal, synchronously. Returns null when
 * there is no terminal (piped stdin, CI, a subprocess spawned by an agent) —
 * which the caller treats as "not authorized".
 *
 * `/dev/tty` is used rather than fd 0 on purpose: fd 0 can be redirected by the
 * caller, `/dev/tty` cannot — it is always the process's controlling terminal.
 */
function promptOnTty(message: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    fs.writeSync(fd, message);
    const buf = Buffer.alloc(4096);
    let out = "";
    while (!out.includes("\n")) {
      let n: number;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (e: any) {
        // A non-blocking tty hands back EAGAIN before the user has typed.
        if (e?.code === "EAGAIN") continue;
        throw e;
      }
      if (n === 0) break;
      out += buf.toString("utf8", 0, n);
    }
    return out.split("\n")[0] ?? "";
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Verify the user authorized `action` on `resourceLabel` by typing the phrase
 * at the terminal. Fails CLOSED: no terminal, or anything other than the exact
 * sentence, returns `authorized:false`.
 */
export function verifyAuthorizationViaTty(
  action: string,
  resourceLabel: string,
): GuardResult {
  const requiredPhrase = buildPhrase(action, resourceLabel);
  const result: GuardResult = { authorized: false, requiredPhrase };

  const answer = promptOnTty(
    `\n⚠️  DESTRUCTIVE ACTION\n\nThis will ${action} ${resourceLabel}.\n\n` +
      `To proceed, type this sentence exactly:\n\n    ${requiredPhrase}\n\n> `,
  );

  if (answer === null) {
    result.reason =
      "Not attached to a terminal, so you cannot be asked to authorize this interactively.";
    return result;
  }
  if (normalize(answer).includes(normalize(requiredPhrase))) {
    result.authorized = true;
    return result;
  }
  result.reason = "What was typed did not match the required authorization sentence.";
  return result;
}

/**
 * Verify the user authorized `action` on `resourceLabel`. Fails CLOSED: any
 * missing transcript, unreadable dir, or absent phrase returns
 * `authorized:false`. Only a genuine user-typed match returns true.
 */
export function verifyAuthorization(
  action: string,
  resourceLabel: string,
  opts: VerifyOptions = {},
): GuardResult {
  const requiredPhrase = buildPhrase(action, resourceLabel);
  const dir =
    opts.transcriptDirOverride ??
    resolveTranscriptDir(opts.cwd, opts.env ?? process.env);

  const result: GuardResult = {
    authorized: false,
    requiredPhrase,
    transcriptDir: dir,
  };

  if (!fs.existsSync(dir)) {
    result.reason = `No Claude Code transcript directory found at ${dir}, so authorization cannot be verified.`;
    return result;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    result.reason = `Could not read the transcript directory ${dir}.`;
    return result;
  }
  if (files.length === 0) {
    result.reason = `No transcript (*.jsonl) files in ${dir}.`;
    return result;
  }

  const needle = normalize(requiredPhrase);
  for (const file of files) {
    const lines = readJsonlLines(path.join(dir, file));
    for (const rec of lines) {
      const text = extractUserTypedText(rec);
      if (text === null) continue;
      if (normalize(text).includes(needle)) {
        result.authorized = true;
        delete result.reason;
        return result;
      }
    }
  }

  result.reason =
    "The required authorization sentence was not found in any message you actually typed.";
  return result;
}

/**
 * Convenience wrapper for tool handlers. Returns null when authorized, or a
 * ready-to-return MCP error result (text + isError) when not.
 */
export function requireAuthorization(
  action: string,
  resourceLabel: string,
  opts: VerifyOptions = {},
): { content: { type: "text"; text: string }[]; isError: true } | null {
  const r =
    authorizationMode === "tty"
      ? verifyAuthorizationViaTty(action, resourceLabel)
      : verifyAuthorization(action, resourceLabel, opts);
  if (r.authorized) return null;

  const how =
    authorizationMode === "tty"
      ? `To proceed, run this command yourself in an interactive terminal and type the sentence ` +
        `when prompted:\n\n    ${r.requiredPhrase}\n\n` +
        `The prompt reads the controlling terminal directly, so it cannot be answered by a ` +
        `script, a pipe, or an assistant running the CLI for you.`
      : `To proceed, the USER (not the assistant) must type this exact sentence in chat, ` +
        `then ask again:\n\n    ${r.requiredPhrase}\n\n` +
        `The server reads the conversation transcript directly to confirm you typed it — ` +
        `the assistant cannot authorize this on your behalf.`;

  const text =
    `⛔ DESTRUCTIVE ACTION BLOCKED.\n\n` +
    `This will ${action} ${resourceLabel}.\n` +
    `${r.reason ?? ""}\n\n` +
    how;
  return { content: [{ type: "text", text }], isError: true };
}

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  verifyAuthorization,
  buildPhrase,
  encodeCwdForClaudeProject,
  extractUserTypedText,
} from "./auth-guard.js";

const ACTION = "delete the site";
const RESOURCE = "staging-acme";
const PHRASE = buildPhrase(ACTION, RESOURCE);

function mkTranscriptDir(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kinsta-guard-"));
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(path.join(dir, "session.jsonl"), lines + "\n");
  return dir;
}

function userText(text: string) {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
}
function userStringContent(text: string) {
  return { type: "user", message: { role: "user", content: text } };
}
function assistantText(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}
function toolResult(text: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: text }] },
  };
}

test("authorizes when the user typed the exact phrase (array content)", () => {
  const dir = mkTranscriptDir([userText(`Yes — ${PHRASE} please`)]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(true);
});

test("authorizes when user content is a plain string", () => {
  const dir = mkTranscriptDir([userStringContent(PHRASE)]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(true);
});

test("tolerates case / whitespace / quote differences", () => {
  const dir = mkTranscriptDir([userText(`  i AUTHORIZE   kinsta to "delete the site" staging-acme `)]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(true);
});

test("REJECTS when the phrase appears only in an assistant record", () => {
  const dir = mkTranscriptDir([assistantText(PHRASE)]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(false);
});

test("REJECTS when the phrase appears only inside a tool_result block", () => {
  const dir = mkTranscriptDir([toolResult(PHRASE)]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(false);
});

test("REJECTS when authorization names a different resource", () => {
  const dir = mkTranscriptDir([userText(buildPhrase(ACTION, "production-acme"))]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(false);
});

test("REJECTS when authorization names a different action", () => {
  const dir = mkTranscriptDir([userText(buildPhrase("reset the site", RESOURCE))]);
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(false);
});

test("fails closed when transcript dir is missing", () => {
  const r = verifyAuthorization(ACTION, RESOURCE, {
    transcriptDirOverride: "/nonexistent/kinsta/guard/dir",
  });
  expect(r.authorized).toBe(false);
  expect(r.reason).toBeDefined();
});

test("fails closed when dir has no jsonl files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kinsta-guard-empty-"));
  const r = verifyAuthorization(ACTION, RESOURCE, { transcriptDirOverride: dir });
  expect(r.authorized).toBe(false);
});

test("extractUserTypedText drops tool_result and keeps text", () => {
  expect(
    extractUserTypedText({
      type: "user",
      message: { content: [{ type: "tool_result", content: "x" }, { type: "text", text: "hi" }] },
    }),
  ).toBe("hi");
  expect(
    extractUserTypedText({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
  ).toBeNull();
});

test("encodeCwdForClaudeProject matches Claude Code's scheme", () => {
  expect(encodeCwdForClaudeProject("/home/leandro/repos/kinsta-mcp")).toBe(
    "-home-leandro-repos-kinsta-mcp",
  );
});

// ── name → id resolution (pure matcher) ──
import { KinstaClient, isUuid } from "./kinsta-client.js";

const c = new KinstaClient({ apiKey: "x" });
const ENVS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "live", display_name: "Live" },
  { id: "22222222-2222-2222-2222-222222222222", name: "staging", display_name: "Staging" },
  { id: "33333333-3333-3333-3333-333333333333", name: "staging", display_name: "Staging" },
];

test("findEnvironment matches by id", () => {
  expect(c.findEnvironment(ENVS, "11111111-1111-1111-1111-111111111111")?.name).toBe("live");
});
test("findEnvironment matches by display_name (case-insensitive)", () => {
  expect(c.findEnvironment(ENVS.slice(0, 2), "live")?.name).toBe("live");
  expect(c.findEnvironment(ENVS.slice(0, 2), "LIVE")?.name).toBe("live");
});
test("findEnvironment returns null when no match", () => {
  expect(c.findEnvironment(ENVS, "nope")).toBeNull();
});
test("findEnvironment throws on ambiguous name", () => {
  expect(() => c.findEnvironment(ENVS, "staging")).toThrow();
});
test("isUuid distinguishes ids from names", () => {
  expect(isUuid("11111111-1111-1111-1111-111111111111")).toBe(true);
  expect(isUuid("staging")).toBe(false);
});

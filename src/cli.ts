/**
 * CLI mode.
 *
 * The same 89 tools the MCP server exposes, callable from a shell:
 *
 *   kinsta-mcp list_sites
 *   kinsta-mcp get_site --site_id abc-123
 *   kinsta-mcp tools            # every tool, one per line
 *   kinsta-mcp help get_site    # that tool's parameters
 *
 * Tools are handed in from index.ts (the single registry both modes read), so a
 * tool added for MCP is a CLI subcommand for free.
 */

import { z } from "zod";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface ToolEntry {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: (args: any) => ToolResult | Promise<ToolResult>;
}

/** `--key value`, `--key=value`, `--flag` (true), `--no-flag` (false). A key
 * repeated becomes an array, so `--x a --x b` fills an array param. */
function parseArgv(argv: string[]): Record<string, string[] | true | false> {
  const out: Record<string, string[] | true | false> = {};
  const push = (key: string, value: string) => {
    const prev = out[key];
    if (Array.isArray(prev)) prev.push(value);
    else out[key] = [value];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${arg}" — parameters are passed as --name value.`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      push(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      if (body.startsWith("no-")) out[body.slice(3)] = false;
      else out[body] = true;
      continue;
    }
    push(body, next);
    i++;
  }
  return out;
}

/**
 * argv is all strings; the tool schemas are not. Rather than reach into zod's
 * internals to learn each field's type, offer the schema the plausible readings
 * of the string and keep the first it accepts. Wrong guesses can't slip
 * through — the field's own schema is the judge.
 */
function coerce(schema: z.ZodTypeAny, raw: string[] | true | false): unknown {
  const candidates: unknown[] = [];

  if (typeof raw === "boolean") {
    candidates.push(raw, String(raw));
  } else if (raw.length > 1) {
    candidates.push(raw);
    const nums = raw.map(Number);
    if (nums.every((n) => !Number.isNaN(n))) candidates.push(nums);
  } else {
    const one = raw[0]!;
    candidates.push(one, [one]);
    const n = Number(one);
    if (one.trim() !== "" && !Number.isNaN(n)) candidates.push(n, [n]);
    if (one === "true") candidates.push(true);
    if (one === "false") candidates.push(false);
    if (/^\s*[[{]/.test(one)) {
      try {
        candidates.push(JSON.parse(one));
      } catch {
        // not JSON; the other readings still apply
      }
    }
  }

  for (const c of candidates) {
    const r = schema.safeParse(c);
    if (r.success) return r.data;
  }
  // Nothing fit — hand back the raw form so the top-level parse reports the
  // field's real error instead of a coercion error we invented.
  return typeof raw === "boolean" ? raw : raw.length > 1 ? raw : raw[0];
}

/** Best-effort one-word type for --help, tolerant of zod version differences. */
function typeName(schema: z.ZodTypeAny): string {
  const def: any = (schema as any).def ?? (schema as any)._def;
  const kind: string | undefined = def?.type ?? def?.typeName;
  switch (kind) {
    case "optional":
    case "default":
    case "nullable":
      return typeName(def.innerType ?? def.type);
    case "enum":
    case "ZodEnum": {
      const values = def.entries ? Object.values(def.entries) : (def.values ?? []);
      return values.length ? values.join("|") : "enum";
    }
    case "array":
    case "ZodArray":
      return `${typeName(def.element ?? def.type)}[] (repeat the flag)`;
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    default:
      return typeof kind === "string" ? kind.replace(/^Zod/, "").toLowerCase() : "value";
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

function toolHelp(tool: ToolEntry): string {
  const lines = [`${tool.name}`, ``, `  ${tool.description}`, ``];
  const entries = Object.entries(tool.shape);
  if (entries.length === 0) {
    lines.push(`  (no parameters)`);
  } else {
    lines.push(`Parameters:`);
    const required = entries.filter(([, s]) => !isOptional(s as z.ZodTypeAny));
    const optional = entries.filter(([, s]) => isOptional(s as z.ZodTypeAny));
    for (const [name, s] of [...required, ...optional]) {
      const schema = s as z.ZodTypeAny;
      const flag = `  --${name} <${typeName(schema)}>`;
      const tags = [isOptional(schema) ? "optional" : "required", schema.description]
        .filter(Boolean)
        .join(" — ");
      lines.push(`${flag.padEnd(46)}${tags}`);
    }
  }
  return lines.join("\n");
}

function usage(tools: Map<string, ToolEntry>): string {
  return [
    `kinsta-mcp — Kinsta hosting, as an MCP server and as a CLI.`,
    ``,
    `Usage:`,
    `  kinsta-mcp                          run as an MCP server on stdio (no args)`,
    `  kinsta-mcp <tool> [--param value]   call one tool and print the result`,
    `  kinsta-mcp tools [filter]           list the ${tools.size} tools (optionally filtered)`,
    `  kinsta-mcp help <tool>              show a tool's parameters`,
    ``,
    `Examples:`,
    `  kinsta-mcp validate_api_key`,
    `  kinsta-mcp list_sites --include_environments`,
    `  kinsta-mcp list_backups --env_id 1234-abcd`,
    ``,
    `Credentials come from KINSTA_API_KEY / KINSTA_COMPANY_ID, or from`,
    `~/.config/kinsta-mcp/{api-key,company-id} — same as the server.`,
    ``,
    `Destructive tools prompt on the terminal for a verbatim authorization`,
    `sentence, and refuse when there is no terminal to ask on.`,
  ].join("\n");
}

/** Run one CLI invocation. Returns the process exit code. */
export async function runCli(
  argv: string[],
  tools: Map<string, ToolEntry>,
): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    const target = command === "help" ? rest[0] : undefined;
    if (target) {
      const tool = tools.get(target);
      if (!tool) {
        console.error(`Unknown tool "${target}". Run \`kinsta-mcp tools\` to list them.`);
        return 1;
      }
      console.log(toolHelp(tool));
      return 0;
    }
    console.log(usage(tools));
    return 0;
  }

  if (command === "tools" || command === "list") {
    const filter = rest[0]?.toLowerCase();
    const width = Math.max(...[...tools.keys()].map((n) => n.length)) + 2;
    let shown = 0;
    for (const tool of tools.values()) {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      if (filter && !haystack.includes(filter)) continue;
      console.log(`${tool.name.padEnd(width)}${tool.description.split(". ")[0]}`);
      shown++;
    }
    if (shown === 0) console.error(`No tools match "${rest[0]}".`);
    return shown === 0 ? 1 : 0;
  }

  const tool = tools.get(command);
  if (!tool) {
    console.error(`Unknown tool "${command}". Run \`kinsta-mcp tools\` to list them.`);
    return 1;
  }

  let raw: Record<string, string[] | true | false>;
  try {
    raw = parseArgv(rest);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  if (raw.help === true || raw.h === true) {
    console.log(toolHelp(tool));
    return 0;
  }

  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = tool.shape[key] as z.ZodTypeAny | undefined;
    if (!field) {
      console.error(
        `Unknown parameter "--${key}" for ${tool.name}. Run \`kinsta-mcp help ${tool.name}\`.`,
      );
      return 1;
    }
    args[key] = coerce(field, value);
  }

  const parsed = z.object(tool.shape).safeParse(args);
  if (!parsed.success) {
    console.error(`Invalid arguments for ${tool.name}:`);
    for (const issue of parsed.error.issues) {
      const where = issue.path.length ? `--${issue.path.join(".")}` : "(arguments)";
      console.error(`  ${where}: ${issue.message}`);
    }
    console.error(`\nRun \`kinsta-mcp help ${tool.name}\` for the full parameter list.`);
    return 1;
  }

  const result = await tool.handler(parsed.data);
  const text = result.content.map((c) => c.text).join("\n");
  if (result.isError) {
    console.error(text);
    return 1;
  }
  console.log(text);
  return 0;
}

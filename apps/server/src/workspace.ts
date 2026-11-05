/**
 * Each real bot owns a folder, `<root>/bots/<name>`, and works from it: commands start there and
 * relative paths resolve there. Its tools are pi's coding tools (bash, read, write, edit, grep, find,
 * ls), with the same access to the whole computer as the user running the daemon.
 *
 * What a daemon restart does to a tool call it cut off (see tools.ts):
 * - read, ls, grep, find only look, and write puts the same content again, so they re-run;
 * - bash and edit may have half-happened or happened, so the model is told and checks first.
 */
import { mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { TopTool } from "./tools.ts";

const REPLAY_SAFE = new Set(["read", "ls", "grep", "find", "write"]);

/** `<root>/bots/<name>`, with the name made safe as a folder name. */
export function botFolder(root: string, name: string): string {
  const safe = name.trim().replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "_") || "bot";
  return join(root, "bots", safe);
}

/** Make the bot's folder if it isn't there. */
export function ensureFolder(folder: string): string {
  mkdirSync(folder, { recursive: true });
  return folder;
}

function adapt(tool: AgentTool<any>): TopTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    replay: REPLAY_SAFE.has(tool.name) ? "safe" : "never",
    run: (args, ctx) => tool.execute(ctx.key, args as never, ctx.signal),
  };
}

/** The tools of a bot working in `folder`. */
export function computerTools(folder: string): TopTool[] {
  return [
    createReadTool(folder),
    createBashTool(folder),
    createEditTool(folder),
    createWriteTool(folder),
    createGrepTool(folder),
    createFindTool(folder),
    createLsTool(folder),
  ].map((tool) => adapt(tool as AgentTool<any>));
}

/** The `workspace` section of a bot's system prompt. `outdated` says an earlier "no tools" note no longer holds. */
export function workspaceSection(folder: string, outdated: boolean): string {
  let user = "the user";
  try {
    user = userInfo().username;
  } catch {
    // no passwd entry: keep the generic name
  }
  return [
    "<workspace>",
    `Your working folder is ${folder}. It's yours: keep your files, notes and projects there. Commands start there and relative paths resolve from it.`,
    `You have full access to this computer (${hostname()}) as ${user}: read, write and edit files anywhere, run shell commands with bash, and search with grep, find and ls.`,
    "What you do takes real effect. Before anything destructive or hard to undo (deleting, overwriting, installing, sending), check first, and ask the user when it isn't clearly what they want.",
    ...(outdated ? ["Earlier instructions saying you have no tools are out of date: you have the tools above."] : []),
    "</workspace>",
  ].join("\n");
}

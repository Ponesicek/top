/**
 * Collar: Top's own tools for managing the app, which every bot always has. It can't be unassigned
 * and isn't listed among the MCP servers set up in Settings.
 *
 * Its tools are named like an MCP server's (`collar__<tool>`, see mcp.ts) so the model sees one
 * consistent scheme, but they run inside the daemon: they work with its state directly, and know
 * which bot is calling from `ctx.bot`. No user-added MCP server may take the name.
 *
 * Tools come in groups, one file per part of the app (`bots.ts`, `mcp.ts`, …), each a `CollarGroup`
 * listed in `GROUPS` below. A group names its tools without the prefix; it's added here.
 *
 * Every tool is sent with every request of every bot, so each one costs context and makes the others
 * harder to pick from: prefer one clear tool over several narrow ones, and describe when to use it.
 */
import type { Daemon } from "../daemon.ts";
import type { TopTool } from "../tools.ts";

export const COLLAR = "collar";

/** One part of the app's tools. Called once when the daemon starts; tools reach the daemon when they run. */
export type CollarGroup = (daemon: Daemon) => readonly TopTool[];

const GROUPS: readonly CollarGroup[] = [];

export function collarTools(daemon: Daemon): TopTool[] {
  const tools = GROUPS.flatMap((group) => group(daemon)).map((tool): TopTool => ({ ...tool, name: `${COLLAR}__${tool.name}` }));
  const names = new Set<string>();
  for (const { name } of tools) {
    if (names.has(name)) throw new Error(`Two Collar tools are named ${name}.`);
    names.add(name);
  }
  return tools;
}

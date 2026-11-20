import type * as Effect from "effect/Effect";
import type { Asks } from "../asks.ts";
import type { Jobs } from "../jobs.ts";
import type { Store } from "../store.ts";
import type { Tasks } from "../tasks/coordinator.ts";
import type { TopTool } from "../tools.ts";
import type { WakeClock } from "../wakes.ts";
import { asksGroup } from "./asks.ts";
import { backgroundGroup } from "./background.ts";
import { jobsGroup } from "./jobs.ts";
import { COLLAR } from "./names.ts";
import { tasksGroup } from "./tasks.ts";
import { wakeGroup } from "./wake.ts";

export { COLLAR };

export type CollarDaemon = {
  readonly store: Store["Service"];
  readonly jobs: Jobs;
  readonly wakes: WakeClock;
  readonly asks: Asks;
  readonly tasks?: Tasks | undefined;
  readonly changed: (bot: number) => Effect.Effect<void>;
  readonly toolsOf: (bot: number) => readonly TopTool[];
};

export type CollarGroup = (daemon: CollarDaemon) => readonly TopTool[];

const GROUPS: readonly CollarGroup[] = [wakeGroup, backgroundGroup, jobsGroup, asksGroup, tasksGroup];

export function collarTools(daemon: CollarDaemon): TopTool[] {
  const tools = GROUPS.flatMap((group) => group(daemon)).map((tool): TopTool => ({ ...tool, name: `${COLLAR}__${tool.name}` }));
  const names = new Set<string>();
  for (const { name } of tools) {
    if (names.has(name)) throw new Error(`Two Collar tools are named ${name}.`);
    names.add(name);
  }
  return tools;
}

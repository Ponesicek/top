import { inspect } from "node:util";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

const render = (part: unknown) => (typeof part === "string" ? part : Cause.isCause(part) ? Cause.pretty(part) : inspect(part, { depth: 4 }));

export const topLogger = Logger.make<unknown, void>(({ message, logLevel, cause }) => {
  const parts = Array.isArray(message) ? message : [message];
  const failure = cause.reasons.length ? `\n${Cause.pretty(cause)}` : "";
  const line = `[top] ${parts.map(render).join(" ")}${failure}`;
  if (logLevel === "Error" || logLevel === "Fatal") console.error(line);
  else if (logLevel === "Warn") console.warn(line);
  else console.log(line);
});

export const layer = Logger.layer([topLogger]);

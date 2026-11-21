import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const expandTilde = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

export const defaultHome: Effect.Effect<string, Config.ConfigError> = Effect.map(Config.option(Config.String("TOP_HOME")), (dir) =>
  resolve(Option.match(dir, { onNone: () => join(homedir(), ".top"), onSome: expandTilde })),
);

export const layout = (home: string) => {
  const server = join(home, "server");
  return {
    home,
    server,
    bots: join(home, "bots"),
    skills: join(home, "skills"),
    database: join(server, "top.sqlite"),
    auth: join(server, "auth.json"),
    chatgptHost: join(server, "chatgpt-host.json"),
  };
};

export type Layout = ReturnType<typeof layout>;

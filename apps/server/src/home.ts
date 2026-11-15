/**
 * Top's home folder: `$TOP_HOME`, else `~/.top`. Everything Top keeps lives in it.
 *
 *   ~/.top/
 *   ├── server/           the daemon's own state: top.sqlite, attachments/, auth.json
 *   ├── bots/<name>/      each bot's working folder, with files/ for what it makes for the user
 *   └── desktop/          the desktop app's profile (its cache and settings; see electron/main.js)
 *
 * Fake bots get a home of their own (`.data/fake` by default), laid out the same way, so trying them
 * never touches the real one.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** `~` or `~/…` made absolute. */
export const expandTilde = (path: string) => path.replace(/^~(?=$|\/)/, homedir());

/** `$TOP_HOME`, else `~/.top`. */
export const defaultHome: Effect.Effect<string, Config.ConfigError> = Effect.map(Config.option(Config.String("TOP_HOME")), (dir) =>
  resolve(Option.match(dir, { onNone: () => join(homedir(), ".top"), onSome: expandTilde })),
);

/** Where things go inside a home. Bots' folders are `<bots>/<name>` (see workspace.ts's botFolder). */
export const layout = (home: string) => {
  const server = join(home, "server");
  return {
    home,
    server,
    bots: join(home, "bots"),
    database: join(server, "top.sqlite"),
    auth: join(server, "auth.json"),
  };
};

export type Layout = ReturnType<typeof layout>;

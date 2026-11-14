/**
 * Model credentials, shared with pi: the same `auth.json` that `pi` signs in to (`/login`), so a
 * ChatGPT, Copilot or Claude subscription pi already uses works here with no extra setup. API keys
 * from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) work too; pi-ai reads those itself.
 *
 * OAuth refresh tokens rotate, so every write goes through the same file lock pi takes. Otherwise the
 * daemon and pi could each refresh at once, and the loser would be signed out.
 *
 * pi-ai asks for credentials through its `CredentialStore` interface, which is Promise-based: this is
 * the adapter, with the work done as Effects inside.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import lockfile from "proper-lockfile";

/** pi's credentials file: `$PI_CODING_AGENT_DIR/auth.json`, else `~/.pi/agent/auth.json`. */
export const piAuthPath: Effect.Effect<string, Config.ConfigError> = Effect.gen(function* () {
  const dir = yield* Config.option(Config.String("PI_CODING_AGENT_DIR"));
  const folder = Option.match(dir, { onNone: () => join(homedir(), ".pi", "agent"), onSome: (d) => d.replace(/^~(?=$|\/)/, homedir()) });
  return join(folder, "auth.json");
});

type AuthFile = Record<string, Credential>;

export class PiAuthFile implements CredentialStore {
  readonly path: string;
  readonly #fs: FileSystem.FileSystem;

  constructor(path: string, fs: FileSystem.FileSystem) {
    this.path = path;
    this.#fs = fs;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Effect.runPromise(Effect.map(this.#load, (file) => file[providerId]));
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Effect.runPromise(Effect.map(this.#load, (file) => Object.entries(file).map(([providerId, credential]) => ({ providerId, type: credential.type }))));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return Effect.runPromise(
      this.#locked((file) =>
        Effect.map(
          Effect.promise(() => fn(file[providerId])),
          (next) => (next === undefined ? undefined : { ...file, [providerId]: next }),
        ),
      ).pipe(Effect.andThen(Effect.map(this.#load, (file) => file[providerId]))),
    );
  }

  delete(providerId: string): Promise<void> {
    return Effect.runPromise(
      this.#locked((file) => {
        if (!(providerId in file)) return Effect.undefined;
        const { [providerId]: _gone, ...rest } = file;
        return Effect.succeed(rest);
      }),
    );
  }

  /** The file as it is now; missing or unreadable is empty. */
  get #load(): Effect.Effect<AuthFile> {
    return this.#fs.readFileString(this.path).pipe(
      Effect.map((text) => {
        try {
          const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
          return parsed && typeof parsed === "object" ? (parsed as AuthFile) : {};
        } catch {
          return {};
        }
      }),
      Effect.orElseSucceed((): AuthFile => ({})),
    );
  }

  /** Read-modify-write under pi's lock; `fn` returns the new file, or undefined to leave it. */
  #locked(fn: (file: AuthFile) => Effect.Effect<AuthFile | undefined>): Effect.Effect<void> {
    const path = this.path;
    const fs = this.#fs;
    const load = this.#load;
    return Effect.scoped(
      Effect.gen(function* () {
        if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) {
          yield* Effect.orDie(fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 }));
          yield* Effect.orDie(fs.writeFileString(path, "{}", { mode: 0o600 }));
        }
        yield* Effect.acquireRelease(
          Effect.promise(() => lockfile.lock(path, { realpath: false, stale: 30_000, retries: { retries: 50, minTimeout: 20, maxTimeout: 1_000 } })),
          (release) => Effect.promise(() => release()),
        );
        const next = yield* Effect.flatMap(load, fn);
        if (next) yield* Effect.orDie(fs.writeFileString(path, JSON.stringify(next, null, 2), { mode: 0o600 }));
      }),
    );
  }
}

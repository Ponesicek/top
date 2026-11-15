/**
 * Model credentials, in Top's own `~/.top/server/auth.json` (see home.ts), in pi's format. A provider
 * pi is already signed in to (a ChatGPT, Copilot or Claude subscription) is copied from pi's
 * `auth.json` the first time Top needs it, so there's no extra setup. API keys from the environment
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) work too; pi-ai reads those itself.
 *
 * OAuth refresh tokens rotate, so every write goes through a file lock (the one pi takes on its own
 * file). Otherwise two daemons on one home could each refresh at once, and the loser would be signed out.
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
import * as Schema from "effect/Schema";
import lockfile from "proper-lockfile";
import { expandTilde } from "./home.ts";

/** pi's credentials file: `$PI_CODING_AGENT_DIR/auth.json`, else `~/.pi/agent/auth.json`. */
export const piAuthPath: Effect.Effect<string, Config.ConfigError> = Effect.gen(function* () {
  const dir = yield* Config.option(Config.String("PI_CODING_AGENT_DIR"));
  const folder = Option.match(dir, { onNone: () => join(homedir(), ".pi", "agent"), onSome: expandTilde });
  return join(folder, "auth.json");
});

/**
 * The file: provider id → credential. Entries are kept as they are, also ones Top can't read (a newer
 * pi's), so writing one credential never drops another.
 */
type AuthEntries = Readonly<Record<string, unknown>>;
const parseAuthFile = Schema.decodeOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

/** What Top checks of a credential before handing it to pi-ai; the rest of it is pi-ai's. */
const CredentialShape = Schema.Union([
  Schema.Struct({ type: Schema.Literal("api_key"), key: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("oauth"), refresh: Schema.String, access: Schema.String, expires: Schema.Number }),
]);
const isCredential = Schema.is(CredentialShape);
const credentialOf = (value: unknown): Credential | undefined => (isCredential(value) ? value : undefined);

/** An `auth.json` in pi's format: Top's own, or pi's (to import from). */
export class AuthFile implements CredentialStore {
  readonly path: string;
  readonly #fs: FileSystem.FileSystem;

  constructor(path: string, fs: FileSystem.FileSystem) {
    this.path = path;
    this.#fs = fs;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return Effect.runPromise(Effect.map(this.#load, (file) => credentialOf(file[providerId])));
  }

  list(): Promise<readonly CredentialInfo[]> {
    return Effect.runPromise(
      Effect.map(this.#load, (file) =>
        Object.entries(file).flatMap(([providerId, value]) => {
          const credential = credentialOf(value);
          return credential ? [{ providerId, type: credential.type }] : [];
        }),
      ),
    );
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return Effect.runPromise(
      this.#locked((file) =>
        Effect.map(
          Effect.promise(() => fn(credentialOf(file[providerId]))),
          (next) => (next === undefined ? undefined : { ...file, [providerId]: next }),
        ),
      ).pipe(Effect.andThen(Effect.map(this.#load, (file) => credentialOf(file[providerId])))),
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
  get #load(): Effect.Effect<AuthEntries> {
    return this.#fs.readFileString(this.path).pipe(
      Effect.map((text) => Option.getOrElse(parseAuthFile(text.replace(/^\uFEFF/, "")), (): AuthEntries => ({}))),
      Effect.orElseSucceed((): AuthEntries => ({})),
    );
  }

  /** Read-modify-write under the file's lock (pi's, for pi's file); `fn` returns the new file, or undefined to leave it. */
  #locked(fn: (file: AuthEntries) => Effect.Effect<AuthEntries | undefined>): Effect.Effect<void> {
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

/**
 * Copy pi's credential for `providerId` into `top` if `top` has none, and say whether it did. After
 * that each keeps its own: signing in again in pi doesn't reach Top.
 */
export const importFromPi = (top: AuthFile, providerId: string, fs: FileSystem.FileSystem): Effect.Effect<boolean, Config.ConfigError> =>
  Effect.gen(function* () {
    if (yield* Effect.promise(() => top.read(providerId))) return false;
    const pi = new AuthFile(yield* piAuthPath, fs);
    if (pi.path === top.path) return false;
    const theirs = yield* Effect.promise(() => pi.read(providerId));
    if (!theirs) return false;
    // Under the lock, so a credential that appeared since (another daemon's import) is kept.
    let copied = false;
    yield* Effect.promise(() =>
      top.modify(providerId, async (current) => {
        copied = !current;
        return current ?? theirs;
      }),
    );
    return copied;
  });

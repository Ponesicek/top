/**
 * Model credentials, in Top's own `~/.top/server/auth.json` (see home.ts), in pi's format: what Sign
 * in with ChatGPT saves (see chatgpt.ts), and API keys. API keys from the environment
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) work too; pi-ai reads those itself.
 *
 * OAuth refresh tokens rotate, so every write goes through a file lock. Otherwise the daemon and
 * `top login` (or two daemons on one home) could each write at once, and the loser would be signed out.
 *
 * pi-ai asks for credentials through its `CredentialStore` interface, which is Promise-based: this is
 * the adapter, with the work done as Effects inside.
 */
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import lockfile from "proper-lockfile";

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

/** An `auth.json` in pi's format. */
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

  /** Read-modify-write under the file's lock; `fn` returns the new file, or undefined to leave it. */
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

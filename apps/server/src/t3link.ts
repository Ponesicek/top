// Settings → T3 Code: pair the daemon with a T3 Code server, check that connection and forget it, as `top t3code …`
// does on the daemon's computer. The credential stays in the file; nothing here returns or logs it, or the pairing code.
import { T3CodeError, type T3CodeView } from "@top/protocol";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { checkSession, overview, pair, preflight, readT3Config, removeT3Config, type T3Config, verifyEnvironment } from "./tasks/t3api.ts";

const CHECK_MS = 10_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failed = (error: unknown) => new T3CodeError({ message: message(error) });

export class T3Link extends Context.Service<
  T3Link,
  {
    /** Checks the saved connection now; a connection that doesn't work comes back with its `error`. */
    readonly view: Effect.Effect<T3CodeView>;
    readonly connect: (address: string, code: string, plainHttp: boolean) => Effect.Effect<T3CodeView, T3CodeError>;
    /** Forgets the saved session. Tasks already running keep the connection they have until they end. */
    readonly disconnect: Effect.Effect<void, T3CodeError>;
  }
>()("top/T3Link") {}

const saved = (config: T3Config): T3CodeView => ({ url: config.url, label: config.label, connectedAt: config.connectedAt });

async function check(config: T3Config): Promise<T3CodeView> {
  const descriptor = await verifyEnvironment(config);
  const session = await checkSession(config.url, config.token);
  const { providers, projects } = await overview(config);
  return {
    ...saved(config),
    serverVersion: descriptor.serverVersion,
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    providers: providers.map((p) => {
      const preferred = p.models.find((m) => m.isDefault)?.slug;
      return { id: p.id, status: p.status, models: p.models.map((m) => m.slug), ...(preferred ? { defaultModel: preferred } : {}) };
    }),
    projects: projects.map((p) => ({ title: p.title, path: p.workspaceRoot })),
  };
}

/** Gives up waiting after a while; what it was doing only reads, so it may finish on its own. */
const within = <A>(run: () => Promise<A>, late: string) =>
  Effect.tryPromise({ try: run, catch: failed }).pipe(
    Effect.timeoutOrElse({ duration: Duration.millis(CHECK_MS), orElse: () => Effect.fail(new T3CodeError({ message: late })) }),
  );
const lateFrom = (where: string) => `T3 Code at ${where} didn't answer within ${CHECK_MS / 1000} s.`;

export const layer = (file: string): Layer.Layer<T3Link> =>
  Layer.effect(
    T3Link,
    Effect.gen(function* () {
      // One change at a time: a disconnect sent while a connect is under way lands after it.
      const changing = yield* Semaphore.make(1);
      const checked = (config: T3Config) =>
        within(() => check(config), lateFrom(config.url)).pipe(Effect.catch((error) => Effect.succeed<T3CodeView>({ ...saved(config), error: error.message })));

      const view = Effect.gen(function* () {
        const config = yield* Effect.tryPromise({ try: () => readT3Config(file), catch: failed });
        return config ? yield* checked(config) : {};
      }).pipe(Effect.catch((error) => Effect.succeed<T3CodeView>({ error: `Top couldn't read its T3 Code connection (${file}): ${error.message}` })));

      const connect = (address: string, code: string, plainHttp: boolean) =>
        changing.withPermits(1)(
          Effect.gen(function* () {
            // Nothing secret has gone anywhere yet, so a T3 Code that doesn't answer is given up on here.
            const found = yield* within(() => preflight(address, plainHttp, 'switch on "Allow plain HTTP"'), lateFrom(address.trim()));
            // From here the code is spent: always seen through, so a session T3 Code made is saved.
            const paired = yield* Effect.tryPromise({ try: () => pair(file, found.origin, found.descriptor, code), catch: failed });
            yield* Effect.log(`paired with T3 Code ${found.descriptor.serverVersion} at ${paired.config.url} (${paired.config.label}) from Settings`);
            return yield* checked(paired.config);
          }),
        );

      const disconnect = changing.withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => removeT3Config(file), catch: failed });
          yield* Effect.log("forgot the T3 Code connection, from Settings");
        }),
      );

      return T3Link.of({ view, connect, disconnect });
    }),
  );

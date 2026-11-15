/**
 * Sign in with ChatGPT: the bots use the user's ChatGPT plan, signed in by Top itself (from the app,
 * or with `top login`), not borrowed from another tool.
 *
 * The flow is pi-ai's (OpenAI's flow for open-source and local agents). Each sign-in registers Top as
 * its own client ("Top", this installation's host id) and gets its own refresh token. Top doesn't
 * copy another app's sign-in: OpenAI's terms only allow tokens from the supported sign-in flow, used
 * under the app's own name. The tokens stay in `~/.top/server/auth.json` (see auth.ts).
 *
 * The browser comes back to `127.0.0.1:1455` on the computer it ran on. On the daemon's own computer,
 * pi-ai is listening there, and the sign-in finishes by itself. From anywhere else, the user pastes
 * the address that page ended on (see the protocol's AccountView).
 *
 * The bots run on their own (wake-ups, background jobs), and OpenAI's terms ask for the user's consent
 * before background use. So every sign-in records that consent first, in `chatgpt-host.json`.
 */
import { randomUUID } from "node:crypto";
import type { AuthInteraction, Models } from "@earendil-works/pi-ai";
import { type AccountView, CHATGPT_REDIRECT } from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Events } from "./events.ts";

/** The provider whose sign-in is Sign in with ChatGPT. */
export const CHATGPT_PROVIDER = "openai";
/** The name Top signs in under; the user sees it in ChatGPT's settings. */
const AGENT_NAME = "Top";
/** How often the daemon checks for a sign-in made elsewhere (`top login`), or one that ran out. */
const RECHECK = Duration.seconds(15);

/** A sign-in that couldn't start or finish; `message` is for the user. */
export class SignInError extends Data.TaggedError("SignInError")<{ readonly message: string }> {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── this installation ────────────────────────────────────────────────────────────

const HostFile = Schema.Struct({
  /** OpenAI's `ext_agent_host_id`: one per installation, kept across sign-ins. */
  hostId: Schema.String,
  /** When the user last agreed that the bots may use their plan in the background (ms since epoch). */
  backgroundConsentAt: Schema.optionalKey(Schema.Number),
});
type HostFile = typeof HostFile.Type;
const parseHostFile = Schema.decodeOption(Schema.fromJsonString(HostFile));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const writeHost = (fs: FileSystem.FileSystem, path: string, host: HostFile) =>
  Effect.orDie(fs.writeFileString(path, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 }));

/** This installation's host file, made (with a new host id) the first time. */
export const hostOf = (fs: FileSystem.FileSystem, path: string): Effect.Effect<HostFile> =>
  Effect.gen(function* () {
    const text = yield* Effect.option(fs.readFileString(path));
    const current = Option.flatMap(text, parseHostFile);
    if (Option.isSome(current) && UUID.test(current.value.hostId)) return current.value;
    const made = { hostId: randomUUID() };
    yield* writeHost(fs, path, made);
    return made;
  });

/** Record that the user agreed to background use, and answer the host file. */
export const recordConsent = (fs: FileSystem.FileSystem, path: string): Effect.Effect<HostFile> =>
  Effect.gen(function* () {
    const host = { ...(yield* hostOf(fs, path)), backgroundConsentAt: yield* Clock.currentTimeMillis };
    yield* writeHost(fs, path, host);
    return host;
  });

/** Run the sign-in. It saves the credential through the models' credential store. */
export const signInWithChatGPT = (models: Models, hostId: string, interaction: AuthInteraction) =>
  models.login(CHATGPT_PROVIDER, "oauth", interaction, { getDeviceId: () => hostId, agentName: AGENT_NAME });

/**
 * Check a pasted address before it's handed to the sign-in: a wrong one would end the sign-in, and the
 * user would have to start over. `state` is the one in the page this sign-in opened. Answers the
 * address to hand over, or what's wrong with it.
 */
export function checkPasted(input: string, state: string | undefined): { readonly url: string } | { readonly problem: string } {
  const whole = `Paste the whole address from the browser's address bar. It starts with ${CHATGPT_REDIRECT}.`;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { problem: whole };
  }
  // The browser may show `localhost`; it's the same page.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  const expected = new URL(CHATGPT_REDIRECT);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) return { problem: whole };
  if (state !== undefined && url.searchParams.get("state") !== state)
    return { problem: "That address is from another sign-in. Paste the one this sign-in ended on." };
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) return { problem: whole };
  return { url: url.toString() };
}

// ── the daemon's side ────────────────────────────────────────────────────────────

export class ChatGPT extends Context.Service<
  ChatGPT,
  {
    /** What the bots' requests are signed in with now. */
    readonly view: Effect.Effect<AccountView>;
    /** Start a sign-in (dropping one under way), with the user's consent to background use. Answers the page to open. */
    readonly signIn: Effect.Effect<string, SignInError>;
    /** Finish the sign-in under way with the address the browser ended on. */
    readonly finish: (url: string) => Effect.Effect<void, SignInError>;
    readonly cancel: Effect.Effect<void>;
    readonly signOut: Effect.Effect<void>;
  }
>()("top/ChatGPT") {}

/** A sign-in under way. `step.paste` answers its "paste the address" step, once pi-ai asks it. */
type Attempt = {
  readonly url: string;
  readonly state: string | undefined;
  readonly abort: AbortController;
  readonly step: { paste?: (url: string) => void };
  /** Settles with why it failed, or `undefined` when it signed in. */
  readonly settled: Promise<string | undefined>;
};

export const layer = (options: {
  readonly models: Models;
  /** The bots' model, `provider/model-id`. */
  readonly model: string;
  readonly hostPath: string;
  readonly fs: FileSystem.FileSystem;
}): Layer.Layer<ChatGPT, never, Events> =>
  Layer.effect(
    ChatGPT,
    Effect.gen(function* () {
      const events = yield* Events;
      const services = yield* Effect.context<never>();
      const { models, model, hostPath, fs } = options;
      const providerId = model.slice(0, model.indexOf("/"));
      const canSignIn = providerId === CHATGPT_PROVIDER;
      let current: Attempt | undefined;
      let error: string | undefined;
      let published = "";

      const view = Effect.promise(async (): Promise<AccountView> => {
        const auth = await models.checkAuth(providerId).catch(() => undefined);
        return {
          model,
          canSignIn,
          ...(auth ? { signedIn: auth.type === "oauth" && canSignIn ? "chatgpt" : "apiKey" } : {}),
          ...(current ? { signingIn: current.url } : {}),
          ...(error ? { error } : {}),
        } satisfies AccountView;
      });
      /** Tell the clients, when something changed. */
      const publish = Effect.gen(function* () {
        const next = yield* view;
        const key = JSON.stringify(next);
        if (key === published) return;
        published = key;
        yield* events.publish({ _tag: "Account", view: next });
      });

      const cancel = Effect.gen(function* () {
        const attempt = current;
        if (!attempt) return;
        attempt.abort.abort();
        // Its listener on :1455 closes as it settles; a new sign-in needs the port.
        yield* Effect.promise(() => attempt.settled);
        yield* publish;
      });

      const start = (hostId: string) =>
        Effect.callback<string, SignInError>((resume) => {
          const abort = new AbortController();
          // pi-ai asks for the address right after it opens the page, before `attempt` exists.
          const step: Attempt["step"] = {};
          let resolveUrl: (url: string) => void = () => {};
          const opened = new Promise<string>((resolve) => {
            resolveUrl = resolve;
          });
          const interaction: AuthInteraction = {
            signal: abort.signal,
            notify: (event) => {
              if (event.type === "auth_url") resolveUrl(event.url);
            },
            prompt: (prompt) => {
              if (prompt.type !== "manual_code") return Promise.reject(new Error(`Top can't answer this sign-in step: ${prompt.message}`));
              return new Promise<string>((resolve, reject) => {
                const stop = () => reject(new Error("Sign-in cancelled"));
                if (prompt.signal?.aborted) return stop();
                prompt.signal?.addEventListener("abort", stop, { once: true });
                step.paste = resolve;
              });
            },
          };
          let attempt: Attempt | undefined;
          const settled = signInWithChatGPT(models, hostId, interaction).then(
            () => undefined,
            (cause: unknown) => (abort.signal.aborted ? "Sign-in cancelled." : messageOf(cause)),
          );
          void opened.then((url) => {
            let state: string | undefined;
            try {
              state = new URL(url).searchParams.get("state") ?? undefined;
            } catch {
              // pi-ai made it; without its state, a pasted address is only checked by pi-ai
            }
            attempt = { url, state, abort, step, settled };
            current = attempt;
            error = undefined;
            resume(Effect.succeed(url));
          });
          void settled.then((failure) => {
            // Failed before it opened a page (the port is taken): the request says why.
            if (!attempt) return resume(Effect.fail(new SignInError({ message: failure ?? "The sign-in ended before it began." })));
            if (current !== attempt) return;
            current = undefined;
            error = failure === "Sign-in cancelled." ? undefined : failure;
            Effect.runForkWith(services)(publish);
          });
          return Effect.sync(() => abort.abort());
        });

      const signIn = Effect.gen(function* () {
        if (!canSignIn)
          return yield* new SignInError({ message: `Sign in with ChatGPT is for OpenAI models; the bots run on ${model}. Use an API key for it.` });
        const host = yield* recordConsent(fs, hostPath);
        yield* cancel;
        const url = yield* start(host.hostId);
        yield* publish;
        return url;
      });

      const finish = (input: string) =>
        Effect.gen(function* () {
          const attempt = current;
          if (!attempt) return yield* new SignInError({ message: "No sign-in is under way. Start again with Continue with ChatGPT." });
          const checked = checkPasted(input, attempt.state);
          if ("problem" in checked) return yield* new SignInError({ message: checked.problem });
          const paste = attempt.step.paste;
          if (!paste) return yield* new SignInError({ message: "The sign-in isn't ready for the address yet. Try again in a moment." });
          paste(checked.url);
          const failure = yield* Effect.promise(() => attempt.settled);
          if (failure) return yield* new SignInError({ message: failure });
          yield* publish;
        });

      const signOut = Effect.gen(function* () {
        yield* cancel;
        error = undefined;
        yield* Effect.promise(() => models.logout(providerId).catch(() => undefined));
        yield* publish;
      });

      // A sign-in made with `top login` while the daemon runs, or a credential that stopped working.
      yield* Effect.forkScoped(Effect.repeat(publish, Schedule.spaced(RECHECK)));
      yield* Effect.addFinalizer(() => Effect.sync(() => current?.abort.abort()));

      return ChatGPT.of({ view, signIn, finish, cancel, signOut });
    }),
  );

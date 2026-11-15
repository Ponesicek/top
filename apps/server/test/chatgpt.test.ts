import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthInteraction, createModels, createProvider, type LoginOptions, type OAuthAuth } from "@earendil-works/pi-ai";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CHATGPT_REDIRECT } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import { afterAll as after, test } from "vitest";
import { AuthFile } from "../src/auth.ts";
import { ChatGPT, checkPasted, layer, type SignInError } from "../src/chatgpt.ts";
import { Events, layer as eventsLayer } from "../src/events.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** OpenAI's sign-in as pi-ai runs it, without the browser: it opens a page, then waits for the address the browser ended on. */
function fakeOpenAI() {
  const logins: { hostId: string | undefined; agentName: string | undefined; cancelled: boolean }[] = [];
  let next = 0;
  const oauth: OAuthAuth = {
    name: "OpenAI (fake)",
    login: async (interaction: AuthInteraction & { signal: AbortSignal }, options?: LoginOptions) => {
      const login = { hostId: options?.getDeviceId?.(), agentName: options?.agentName, cancelled: false };
      logins.push(login);
      const state = `state-${next++}`;
      interaction.notify({ type: "auth_url", url: `https://auth.example/authorize?state=${state}` });
      let input: string;
      try {
        input = await interaction.prompt({ type: "manual_code", message: "Paste the address", signal: interaction.signal });
      } catch (error) {
        login.cancelled = true;
        throw error;
      }
      const url = new URL(input);
      if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
      return { type: "oauth", access: `access-${url.searchParams.get("code")}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
    },
    refresh: async (credential) => credential,
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
  const unused = () => {
    throw new Error("not in this test");
  };
  return { oauth, logins, provider: createProvider({ id: "openai", auth: { oauth }, models: [], api: { stream: unused, streamSimple: unused } }) };
}

async function setup(model = "openai/gpt-test") {
  const dir = mkdtempSync(join(tmpdir(), "top-chatgpt-"));
  dirs.push(dir);
  const fs = await Effect.runPromise(Effect.provide(Effect.service(FileSystem.FileSystem), NodeServices.layer));
  const auth = join(dir, "auth.json");
  const hostPath = join(dir, "chatgpt-host.json");
  const openai = fakeOpenAI();
  const models = createModels({ credentials: new AuthFile(auth, fs) });
  models.setProvider(openai.provider);
  const runtime = ManagedRuntime.make(layer({ models, model, hostPath, fs }).pipe(Layer.provideMerge(eventsLayer)));
  after(() => runtime.dispose());
  const run = <A, E>(effect: Effect.Effect<A, E, ChatGPT | Events>) => runtime.runPromise(effect);
  /** Why `effect` failed, or "succeeded". */
  const fails = <A>(effect: Effect.Effect<A, SignInError, ChatGPT>) =>
    run(
      Effect.match(effect, {
        onFailure: (e) => e.message,
        onSuccess: () => "succeeded",
      }),
    );
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  return { run, fails, openai, auth, hostPath, read };
}

const pasted = (page: string, code: string, host = "127.0.0.1") => {
  const state = new URL(page).searchParams.get("state");
  return `${CHATGPT_REDIRECT.replace("127.0.0.1", host)}?code=${code}&state=${state}&client_id=oaiapp_1`;
};

test("signs in with the pasted address, as Top, on this installation's host id, after consent to background use", async () => {
  const { run, fails, openai, auth, hostPath, read } = await setup();
  assert.deepEqual(await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.view)), { model: "openai/gpt-test", canSignIn: true });

  const page = await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.signIn));
  const host = read(hostPath);
  assert.match(host.hostId, /^[0-9a-f-]{36}$/);
  assert.equal(typeof host.backgroundConsentAt, "number");
  assert.equal((await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.view))).signingIn, page);

  // A wrong address is refused before it reaches the sign-in, which goes on.
  assert.match(await fails(Effect.flatMap(Effect.service(ChatGPT), (c) => c.finish("signed in!"))), /Paste the whole address/);
  assert.match(await fails(Effect.flatMap(Effect.service(ChatGPT), (c) => c.finish(`${CHATGPT_REDIRECT}?code=x&state=old`))), /another sign-in/);

  const changes = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const { subscription } = yield* (yield* Events).subscribe;
        // The browser showed `localhost`; it's the same page.
        yield* (yield* ChatGPT).finish(pasted(page, "abc", "localhost"));
        return yield* PubSub.takeAll(subscription);
      }),
    ),
  );
  assert.ok(changes.some((e) => e._tag === "Account" && e.view.signedIn === "chatgpt"));
  assert.deepEqual(await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.view)), { model: "openai/gpt-test", canSignIn: true, signedIn: "chatgpt" });
  assert.equal(read(auth).openai.access, "access-abc");
  assert.deepEqual(openai.logins, [{ hostId: `${host.hostId}`, agentName: "Top", cancelled: false }]);

  // The same installation keeps its host id on the next sign-in.
  await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.signOut));
  assert.equal(read(auth).openai, undefined);
  assert.equal((await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.view))).signedIn, undefined);
  await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.signIn));
  assert.equal(openai.logins[1]?.hostId, host.hostId);
});

test("a new sign-in drops the one under way, and cancelling ends it without an error", async () => {
  const { run, fails, openai } = await setup();
  const first = await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.signIn));
  const second = await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.signIn));
  assert.notEqual(first, second);
  assert.equal(openai.logins[0]?.cancelled, true);
  // The first page's address belongs to a sign-in that's gone.
  assert.match(await fails(Effect.flatMap(Effect.service(ChatGPT), (c) => c.finish(pasted(first, "x")))), /another sign-in/);

  await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.cancel));
  assert.equal(openai.logins[1]?.cancelled, true);
  assert.deepEqual(await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.view)), { model: "openai/gpt-test", canSignIn: true });
  assert.match(await fails(Effect.flatMap(Effect.service(ChatGPT), (c) => c.finish(pasted(second, "x")))), /No sign-in is under way/);
});

test("bots on another provider's model don't sign in with ChatGPT", async () => {
  const { fails, run } = await setup("anthropic/claude-test");
  assert.equal((await run(Effect.flatMap(Effect.service(ChatGPT), (c) => c.view))).canSignIn, false);
  assert.match(await fails(Effect.flatMap(Effect.service(ChatGPT), (c) => c.signIn)), /for OpenAI models/);
});

test("a pasted address must be the sign-in's own page", () => {
  assert.deepEqual(checkPasted(`  ${CHATGPT_REDIRECT}?code=c&state=s  `, "s"), { url: `${CHATGPT_REDIRECT}?code=c&state=s` });
  assert.ok("problem" in checkPasted("http://127.0.0.1:1456/auth/callback?code=c&state=s", "s"));
  assert.ok("problem" in checkPasted(`${CHATGPT_REDIRECT}?state=s`, "s"));
  // An error from OpenAI goes through, so the sign-in ends with OpenAI's reason.
  assert.ok("url" in checkPasted(`${CHATGPT_REDIRECT}?error=access_denied&state=s`, "s"));
});

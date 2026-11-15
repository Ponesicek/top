/**
 * `top login` and `top logout`: Sign in with ChatGPT from a terminal (see chatgpt.ts). It works whether
 * or not the daemon is running: both use the same `auth.json`, under its lock, and a running daemon
 * picks up the new sign-in within seconds.
 *
 * The browser comes back to 127.0.0.1:1455. On this computer, that finishes the sign-in by itself. Over
 * SSH, open the page on your own computer and paste the address it ended on here.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CHATGPT_BACKGROUND_NOTICE, CHATGPT_REDIRECT, CHATGPT_USAGE_URL } from "@top/protocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { AuthFile } from "./auth.ts";
import { CHATGPT_PROVIDER, checkPasted, recordConsent, signInWithChatGPT } from "./chatgpt.ts";
import type { Layout } from "./home.ts";

const say = (line = "") => Effect.sync(() => process.stdout.write(`${line}\n`));
const fail = (message: string) =>
  Effect.andThen(
    Effect.sync(() => process.stderr.write(`${message}\n`)),
    Effect.sync(() => process.exit(1)),
  );

/** Open a page in this computer's browser, if it has one; the link is printed either way. */
function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser here (SSH): the printed link does
  }
}

const modelsAt = (home: Layout, fs: FileSystem.FileSystem) => builtinModels({ credentials: new AuthFile(home.auth, fs) });

export const signInHere = (home: Layout) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.orDie(fs.makeDirectory(home.server, { recursive: true, mode: 0o700 }));
      const models = modelsAt(home, fs);
      yield* say(CHATGPT_BACKGROUND_NOTICE);
      yield* say(`(${CHATGPT_USAGE_URL})`);
      const lines = yield* Effect.acquireRelease(
        Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
        (l) => Effect.sync(() => l.close()),
      );
      const answer = yield* Effect.promise(() => lines.question("Sign in with ChatGPT on these terms? [y/N] "));
      if (!/^y(es)?$/i.test(answer.trim())) return yield* fail("Not signed in.");
      const host = yield* recordConsent(fs, home.chatgptHost);
      let state: string | undefined;
      const outcome = yield* Effect.promise(() =>
        signInWithChatGPT(models, host.hostId, {
          notify: (event) => {
            if (event.type === "auth_url") {
              state = new URL(event.url).searchParams.get("state") ?? undefined;
              process.stdout.write(
                `\nOpen this page to sign in:\n\n  ${event.url}\n\nOn another computer (over SSH)? Sign in there, then paste the address the page ended on (${CHATGPT_REDIRECT}?…).\n\n`,
              );
              openBrowser(event.url);
            } else if (event.type === "progress" || event.type === "info") process.stdout.write(`${event.message}\n`);
          },
          prompt: async (prompt) => {
            if (prompt.type !== "manual_code") throw new Error(`Top can't answer this sign-in step: ${prompt.message}`);
            // Asked again until the address is one this sign-in can use; the browser finishing it aborts the question.
            for (;;) {
              const input = await lines.question("Address: ", prompt.signal ? { signal: prompt.signal } : {});
              const checked = checkPasted(input, state);
              if ("url" in checked) return checked.url;
              process.stdout.write(`${checked.problem}\n`);
            }
          },
        }).then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      );
      if (outcome !== undefined) return yield* fail(outcome);
      yield* say(`\nSigned in with ChatGPT; saved in ${home.auth}. The bots use your ChatGPT plan now.`);
      // pi-ai's callback server may hold the event loop a moment; the work is done.
      return yield* Effect.sync(() => process.exit(0));
    }),
  );

export const signOutHere = (home: Layout) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.promise(() =>
      modelsAt(home, fs)
        .logout(CHATGPT_PROVIDER)
        .catch(() => undefined),
    );
    yield* say("Signed out of ChatGPT.");
  });

import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { AskError } from "@top/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ToolError, type ToolResult, type TopTool } from "./tools.ts";

export const SECRET_TTL_MS = 60 * 60_000;
export const HIDDEN = "[secret hidden by Top]";
export const MIN_SECRET = 4;
const KEEP_HIDING = 8;
const MAX_KEPT = 200;
const NAME = /^b(\d+)-[0-9a-f]{32}$/;
const MAX_SCRUBBED_BYTES = 64 * 1024 * 1024;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PI_LOG = new RegExp(`(?:"fullOutputPath":"|Full output: )(${escaped(join(tmpdir(), "pi-"))}[\\w-]+\\.log)`, "g");
const IDENTIFIERS = new Set(["kind", "task"]);

type Live = { readonly bot: number; readonly value: string; readonly expiresAt: number };

export type SavedSecret = { readonly path: string; readonly expiresAt: number };

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly dir: string;
    readonly ttlMs: number;
    readonly save: (bot: number, value: string) => Effect.Effect<SavedSecret, AskError>;
    readonly discard: (path: string) => Effect.Effect<void>;
    readonly removeBot: (bot: number) => Effect.Effect<void>;
    readonly redact: (text: string) => string;
    readonly guard: (tool: TopTool) => TopTool;
  }
>()("top/Secrets") {}

function forms(value: string): string[] {
  const all = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  return [...all];
}

export const layer = (serverDir: string, options: { readonly ttlMs?: number } = {}): Layer.Layer<Secrets, never, FileSystem.FileSystem> =>
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scope = yield* Effect.scope;
      const dir = join(serverDir, "secrets");
      const ttlMs = options.ttlMs ?? SECRET_TTL_MS;
      const live = new Map<string, Live>();
      const kept = new Set<string>();
      let hidden: string[] = [];

      const refresh = () => {
        const values = new Set([...[...live.values()].map((s) => s.value), ...kept]);
        hidden = [...values]
          .filter((v) => v.length >= MIN_SECRET)
          .flatMap(forms)
          .sort((a, b) => b.length - a.length);
      };

      const forget = (path: string, keepHiding: boolean) => {
        const secret = live.get(path);
        live.delete(path);
        if (secret && keepHiding && secret.value.length >= KEEP_HIDING) {
          kept.delete(secret.value);
          kept.add(secret.value);
          if (kept.size > MAX_KEPT) kept.delete(kept.values().next().value!);
        }
        refresh();
      };

      const remove = (path: string, keepHiding: boolean) =>
        Effect.suspend(() => {
          forget(path, keepHiding);
          return fs.remove(path, { force: true }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't delete a secret's file", Cause.squash(cause))));
        });

      const expireAt = (path: string, expiresAt: number) =>
        Effect.gen(function* () {
          const wait = expiresAt - (yield* Clock.currentTimeMillis);
          if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
          if (live.get(path)?.expiresAt === expiresAt) yield* remove(path, true);
        }).pipe(Effect.forkIn(scope), Effect.asVoid);

      const ensureDir = Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
        yield* fs.chmod(dir, 0o700);
      });

      const restore = (name: string, now: number) =>
        Effect.gen(function* () {
          const path = join(dir, name);
          const match = NAME.exec(name);
          const info = yield* Effect.tryPromise(() => lstat(path)).pipe(Effect.orElseSucceed(() => undefined));
          const savedAt = info?.mtimeMs ?? 0;
          if (!match || !info?.isFile() || savedAt + ttlMs <= now) return yield* remove(path, false);
          const value = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
          if (value === undefined) return yield* remove(path, false);
          live.set(path, { bot: Number(match[1]), value, expiresAt: savedAt + ttlMs });
          refresh();
          yield* expireAt(path, savedAt + ttlMs);
        });

      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(dir))) return;
        yield* fs.chmod(dir, 0o700);
        const now = yield* Clock.currentTimeMillis;
        for (const name of yield* fs.readDirectory(dir)) yield* restore(name, now);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't look through the saved secrets", Cause.squash(cause))));

      const redact = (text: string): string => {
        let out = text;
        for (const value of hidden) if (out.includes(value)) out = out.split(value).join(HIDDEN);
        return out;
      };
      const deep = (value: JsonValue): JsonValue => {
        if (typeof value === "string") return redact(value);
        if (Array.isArray(value)) return value.map(deep);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, inner]) => [key, IDENTIFIERS.has(key) && typeof inner === "string" ? inner : deep(inner)]),
          );
        return value;
      };
      const clean = (result: ToolResult): ToolResult => {
        if (!hidden.length) return result;
        return {
          ...result,
          content: result.content.map((part) => (part.type === "text" ? { ...part, text: redact(part.text) } : part)),
          details: result.details === undefined ? undefined : deep(result.details),
          ...(result.structuredContent === undefined ? {} : { structuredContent: deep(result.structuredContent) }),
        };
      };
      const piLogs = (text: string) => [...new Set(Array.from(text.matchAll(PI_LOG), (match) => match[1]!))];
      const scrubLog = (path: string) =>
        Effect.gen(function* () {
          const info = yield* Effect.tryPromise(() => lstat(path));
          if (!info.isFile()) return;
          if (Number(info.size) > MAX_SCRUBBED_BYTES) return yield* fs.remove(path);
          const text = yield* fs.readFileString(path);
          const clean = redact(text);
          if (clean !== text) yield* fs.writeFileString(path, clean);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.andThen(
              Effect.logWarning("couldn't hide secrets in a tool's full output, so it's deleted", Cause.squash(cause)),
              fs.remove(path, { force: true }).pipe(Effect.ignore),
            ),
          ),
        );
      const scrubLogsIn = (text: string) => (hidden.length ? Effect.forEach(piLogs(text), scrubLog, { discard: true }) : Effect.void);
      const finish = (result: ToolResult) => Effect.as(scrubLogsIn(JSON.stringify([result.content, result.details ?? null])), clean(result));
      const cleanError = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return Effect.as(scrubLogsIn(message), new ToolError({ message: redact(message) }));
      };

      return Secrets.of({
        dir,
        ttlMs,
        save: (bot, value) =>
          Effect.gen(function* () {
            yield* ensureDir;
            const path = join(dir, `b${bot}-${randomBytes(16).toString("hex")}`);
            yield* fs.writeFileString(path, value, { flag: "wx", mode: 0o600 });
            const expiresAt = (yield* Clock.currentTimeMillis) + ttlMs;
            live.set(path, { bot, value, expiresAt });
            refresh();
            yield* expireAt(path, expiresAt);
            return { path, expiresAt };
          }).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.andThen(
                Effect.logWarning("couldn't save a secret", error.message),
                Effect.fail(new AskError({ message: "Couldn't save it. Try again." })),
              ),
            ),
          ),
        discard: (path) => remove(path, false),
        removeBot: (bot) =>
          Effect.forEach(
            [...live].filter(([, s]) => s.bot === bot),
            ([path]) => remove(path, true),
            { discard: true },
          ),
        redact,
        guard: (tool) => ({
          ...tool,
          run: (args, ctx) =>
            tool.run(args, ctx.onUpdate ? { ...ctx, onUpdate: (partial) => ctx.onUpdate?.(clean(partial)) } : ctx).pipe(
              Effect.flatMap(finish),
              Effect.catch((error) => Effect.flatMap(cleanError(error), Effect.fail)),
              Effect.catchDefect((defect) => Effect.flatMap(cleanError(defect), Effect.fail)),
            ),
          ...(tool.recover
            ? {
                recover: (args, ctx) =>
                  tool.recover!(args, ctx).pipe(
                    Effect.flatMap((result): Effect.Effect<ToolResult | false | undefined> => (result ? finish(result) : Effect.succeed(result))),
                  ),
              }
            : {}),
        }),
      });
    }),
  );

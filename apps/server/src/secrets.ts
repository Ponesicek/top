import { randomBytes } from "node:crypto";
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
const MIN_REDACTED = 4;
const NAME = /^b(\d+)-[0-9a-f]{32}$/;

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

export const layer = (serverDir: string, options: { readonly ttlMs?: number } = {}): Layer.Layer<Secrets, never, FileSystem.FileSystem> =>
  Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scope = yield* Effect.scope;
      const dir = join(serverDir, "secrets");
      const ttlMs = options.ttlMs ?? SECRET_TTL_MS;
      const live = new Map<string, Live>();

      const remove = (path: string) =>
        Effect.suspend(() => {
          live.delete(path);
          return fs.remove(path, { force: true }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't delete a secret's file", Cause.squash(cause))));
        });

      const expireAt = (path: string, expiresAt: number) =>
        Effect.gen(function* () {
          const wait = expiresAt - (yield* Clock.currentTimeMillis);
          if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
          if (live.get(path)?.expiresAt === expiresAt) yield* remove(path);
        }).pipe(Effect.forkIn(scope), Effect.asVoid);

      const ensureDir = Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
        yield* fs.chmod(dir, 0o700);
      });

      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(dir))) return;
        yield* fs.chmod(dir, 0o700);
        const now = yield* Clock.currentTimeMillis;
        for (const name of yield* fs.readDirectory(dir)) {
          const path = join(dir, name);
          const match = NAME.exec(name);
          const info = yield* fs.stat(path);
          const savedAt = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0;
          if (!match || info.type !== "File" || savedAt + ttlMs <= now) {
            yield* remove(path);
            continue;
          }
          const value = yield* fs.readFileString(path);
          live.set(path, { bot: Number(match[1]), value, expiresAt: savedAt + ttlMs });
          yield* expireAt(path, savedAt + ttlMs);
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't look through the saved secrets", Cause.squash(cause))));

      const redact = (text: string): string => {
        if (!live.size) return text;
        let out = text;
        const values = [...live.values()].map((s) => s.value).filter((v) => v.length >= MIN_REDACTED);
        for (const value of values.sort((a, b) => b.length - a.length)) if (out.includes(value)) out = out.split(value).join(HIDDEN);
        return out;
      };
      const deep = (value: JsonValue): JsonValue => {
        if (typeof value === "string") return redact(value);
        if (Array.isArray(value)) return value.map(deep);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, deep(inner)]));
        return value;
      };
      const clean = (result: ToolResult): ToolResult => {
        if (!live.size) return result;
        return {
          ...result,
          content: result.content.map((part) => (part.type === "text" ? { ...part, text: redact(part.text) } : part)),
          details: result.details === undefined ? undefined : deep(result.details),
          ...(result.structuredContent === undefined ? {} : { structuredContent: deep(result.structuredContent) }),
        };
      };
      const cleanError = (error: unknown) => new ToolError({ message: redact(error instanceof Error ? error.message : String(error)) });

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
        discard: remove,
        removeBot: (bot) =>
          Effect.forEach(
            [...live].filter(([, s]) => s.bot === bot),
            ([path]) => remove(path),
            { discard: true },
          ),
        redact,
        guard: (tool) => ({
          ...tool,
          run: (args, ctx) =>
            tool.run(args, ctx.onUpdate ? { ...ctx, onUpdate: (partial) => ctx.onUpdate?.(clean(partial)) } : ctx).pipe(
              Effect.map(clean),
              Effect.mapError(cleanError),
              Effect.catchDefect((defect) => Effect.fail(cleanError(defect))),
            ),
          ...(tool.recover ? { recover: (args, ctx) => tool.recover!(args, ctx).pipe(Effect.map((result) => (result ? clean(result) : result))) } : {}),
        }),
      });
    }),
  );

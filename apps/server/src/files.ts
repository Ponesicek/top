import { join } from "node:path";
import { type FileChange, type FileView, MAX_FILES } from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { type FileStat, Store, type StoredEntry } from "./store.ts";

const SETTLE_MS = 400;
const MAX_WAIT_MS = 4_000;
const POLL_MS = 15_000;
const MAX_DEPTH = 8;
const SKIP = new Set(["node_modules", "__pycache__"]);

export type Listing = { readonly files: ReadonlyMap<string, FileStat>; readonly more: boolean };

const EMPTY: Listing = { files: new Map(), more: false };

export const scan = (folder: string): Effect.Effect<Listing, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = new Map<string, FileStat>();
    let more = false;
    const walk = (dir: string, prefix: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entries = [...(yield* fs.readDirectoryEntries(dir).pipe(Effect.orElseSucceed(() => [])))];
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          if (more) return;
          if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.type === "Directory") {
            if (depth < MAX_DEPTH) yield* walk(join(dir, entry.name), path, depth + 1);
            continue;
          }
          if (entry.type !== "File" && entry.type !== "SymbolicLink") continue;
          const info = yield* Effect.option(fs.stat(join(dir, entry.name)));
          if (Option.isNone(info) || info.value.type !== "File") continue;
          if (files.size >= MAX_FILES) {
            more = true;
            return;
          }
          files.set(path, { size: Number(info.value.size), mtime: Option.match(info.value.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }) });
        }
      });
    yield* walk(folder, "", 0);
    return { files, more };
  });

export function diff(before: ReadonlyMap<string, FileStat>, after: ReadonlyMap<string, FileStat>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, stat] of after) {
    const old = before.get(path);
    if (!old) changes.push({ path, change: "added" });
    else if (old.size !== stat.size || old.mtime !== stat.mtime) changes.push({ path, change: "changed" });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, change: "removed" });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const fileViews = (listing: Listing): FileView[] => [...listing.files].map(([path, { size, mtime }]) => ({ path, size, mtime }));

export type FilesFolder = {
  readonly bot: number;
  readonly folder: string;
  readonly listing: () => Listing;
  readonly rescan: Effect.Effect<void>;
};

export const makeFilesFolder = Effect.fnUntraced(function* (
  bot: number,
  folder: string,
  onChange: (listing: Listing, entry: StoredEntry | undefined) => Effect.Effect<void>,
) {
  const store = yield* Store;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  let known: ReadonlyMap<string, FileStat> | undefined = yield* store.files(bot);
  let listing: Listing = EMPTY;
  const signals = yield* Queue.unbounded<boolean>();
  const signal = (now: boolean) => Queue.offerUnsafe(signals, now);
  const scanning = yield* Semaphore.make(1);
  const watcher = yield* FiberHandle.make();
  let watching = false;

  const watch = Effect.gen(function* () {
    if (watching) return;
    yield* Effect.ignore(fs.makeDirectory(folder, { recursive: true }));
    watching = true;
    yield* FiberHandle.run(
      watcher,
      fs.watch(folder, { recursive: true }).pipe(
        Stream.runForEach(() => Effect.sync(() => signal(false))),
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            watching = false;
            signal(true);
          }),
        ),
      ),
    );
  });

  const scanOnce = Effect.gen(function* () {
    yield* watch;
    const next = yield* scan(folder).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    const changes = known ? diff(known, next.files) : [];
    const first = listing === EMPTY;
    if (known && changes.length === 0) {
      listing = next;
      if (first) yield* onChange(next, undefined);
      return;
    }
    const entry = yield* store.recordFiles(bot, next.files, changes);
    known = next.files;
    listing = next;
    yield* onChange(next, entry);
  }).pipe(Effect.catchCause((cause) => Effect.logError(`listing ${folder}`, cause)));
  const rescan = scanning
    .withPermits(1)(scanOnce)
    .pipe(Effect.withSpan("FilesFolder.rescan", { attributes: { bot } }));

  const settle = Effect.fnUntraced(function* (now: boolean) {
    const deadline = (yield* Clock.currentTimeMillis) + MAX_WAIT_MS;
    let immediate = now;
    while (!immediate) {
      const left = deadline - (yield* Clock.currentTimeMillis);
      if (left <= 0) return;
      const next = yield* Queue.take(signals).pipe(Effect.timeoutOption(Duration.millis(Math.min(SETTLE_MS, left))));
      if (Option.isNone(next)) return;
      immediate = next.value;
    }
  });

  yield* rescan;
  yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(signals), settle).pipe(Effect.andThen(rescan))), scope);
  yield* Effect.forkIn(
    Effect.repeat(
      Effect.sync(() => signal(true)),
      Schedule.spaced(Duration.millis(POLL_MS)),
    ).pipe(Effect.delay(Duration.millis(POLL_MS))),
    scope,
  );

  const folderHandle: FilesFolder = { bot, folder, listing: () => listing, rescan };
  return folderHandle;
});

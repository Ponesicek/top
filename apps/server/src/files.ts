/**
 * Each bot's files folder: what it makes for the user (pages, reports, images, notes). The daemon
 * watches it, keeps its listing in the store, and reports what changed as a `files` entry in the
 * bot's transcript, which clients show and the model never sees. The files themselves are served by
 * serve.ts.
 *
 * Anything may change the folder: the bot's `write` and `edit`, a script it runs with `bash`, the user
 * in their editor. So changes come from the folder itself, not from tool calls:
 *
 * - The OS watcher says something changed; the folder is listed again once writes have settled
 *   (a burst of writes is one change), and at most every few seconds while they keep coming.
 * - A slow poll lists it again now and then, for what the watcher misses (network drives, a watcher
 *   that failed).
 * - The listing is saved with the entry that reports it, so a change made while the daemon was down,
 *   or cut off by a crash before it was reported, is reported when it starts.
 */
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

/** Writes this close together are one change. */
const SETTLE_MS = 400;
/** While writes keep coming, the folder is still listed this often. */
const MAX_WAIT_MS = 4_000;
const POLL_MS = 15_000;
const MAX_DEPTH = 8;
/** Never the user's files; hidden names (`.git`, `.DS_Store`) are skipped too. */
const SKIP = new Set(["node_modules", "__pycache__"]);

export type Listing = { readonly files: ReadonlyMap<string, FileStat>; readonly more: boolean };

const EMPTY: Listing = { files: new Map(), more: false };

/** The files under `folder`, by path relative to it (`/` between parts), at most `MAX_FILES`. */
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
          // Follows a link; a link to a folder isn't walked (it could loop). One removed while listing is skipped.
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

/** What changed between two listings, by path. */
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
  /** What was listed last (empty until the first listing). */
  readonly listing: () => Listing;
  /** List the folder now and report what changed. Listings run one at a time. */
  readonly rescan: Effect.Effect<void>;
};

/**
 * One bot's files folder, watched for as long as the scope it's made in. It's made, listed and watched
 * before this returns. `onChange` gets the new listing, and the entry when something changed.
 */
export const makeFilesFolder = Effect.fnUntraced(function* (
  bot: number,
  folder: string,
  onChange: (listing: Listing, entry: StoredEntry | undefined) => Effect.Effect<void>,
) {
  const store = yield* Store;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  /** What the store holds; `undefined` until the folder was first listed (then nothing is reported). */
  let known: ReadonlyMap<string, FileStat> | undefined = yield* store.files(bot);
  let listing: Listing = EMPTY;
  /** A change to look at: `true` to list at once (the poll, a broken watcher), `false` once writes settle. */
  const signals = yield* Queue.unbounded<boolean>();
  const signal = (now: boolean) => Queue.offerUnsafe(signals, now);
  const scanning = yield* Semaphore.make(1);
  const watcher = yield* FiberHandle.make();
  let watching = false;

  /** Watch the folder (recursively: macOS, Windows and Linux with Node ≥ 20). If it's removed or the watcher breaks, the poll goes on and it's watched again. */
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

  /** Wait for writes to settle (`SETTLE_MS` of quiet), but list at most `MAX_WAIT_MS` after the first. */
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

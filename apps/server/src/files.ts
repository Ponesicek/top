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
import { type Dirent, type FSWatcher, mkdirSync, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FileChange, type FileView, MAX_FILES } from "@top/protocol";
import type { FileStat, Store, StoredEntry } from "./store.ts";

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
export async function scan(folder: string): Promise<Listing> {
  const files = new Map<string, FileStat>();
  let more = false;
  const walk = async (dir: string, prefix: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (more) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(join(dir, entry.name), path, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try {
        // Follows a link; a link to a folder isn't walked (it could loop).
        const info = await stat(join(dir, entry.name));
        if (!info.isFile()) continue;
        if (files.size >= MAX_FILES) {
          more = true;
          return;
        }
        files.set(path, { size: info.size, mtime: Math.round(info.mtimeMs) });
      } catch {
        // removed while listing
      }
    }
  };
  await walk(folder, "", 0);
  return { files, more };
}

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

/** One bot's files folder, watched. `onChange` gets the new listing, and the entry when something changed. */
export class FilesFolder {
  readonly bot: number;
  readonly folder: string;
  readonly #store: Store;
  readonly #onChange: (listing: Listing, entry: StoredEntry | undefined) => void;
  /** What the store holds; `undefined` until the folder was first listed (then nothing is reported). */
  #known: ReadonlyMap<string, FileStat> | undefined;
  #listing: Listing = EMPTY;
  #watcher: FSWatcher | undefined;
  #settle: ReturnType<typeof setTimeout> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #scanning: Promise<void> | undefined;
  #again = false;
  #closed = false;

  constructor(bot: number, folder: string, store: Store, onChange: (listing: Listing, entry: StoredEntry | undefined) => void) {
    this.bot = bot;
    this.folder = folder;
    this.#store = store;
    this.#onChange = onChange;
    this.#known = store.files(bot);
  }

  get listing(): Listing {
    return this.#listing;
  }

  /** Make the folder if it isn't there, list it, and watch it. Resolves once it has been listed. */
  start(): Promise<void> {
    try {
      mkdirSync(this.folder, { recursive: true });
    } catch (error) {
      console.error(`[top] can't make ${this.folder}:`, error);
    }
    this.#watch();
    this.#poll = setInterval(() => this.#schedule(true), POLL_MS);
    this.#poll.unref();
    return this.rescan();
  }

  #watch() {
    if (this.#closed) return;
    try {
      // Recursive watching works on macOS, Windows and (Node ≥ 20) Linux.
      const watcher = watch(this.folder, { recursive: true }, () => this.#schedule());
      watcher.on("error", () => {
        // The folder was removed or the watcher broke: the poll keeps going, and it is watched again.
        watcher.close();
        if (this.#watcher === watcher) this.#watcher = undefined;
        this.#schedule(true);
      });
      this.#watcher = watcher;
    } catch {
      // Not there (yet) or not watchable: the poll covers it.
    }
  }

  /** List the folder again once writes settle, and at most `MAX_WAIT_MS` after the first one. */
  #schedule(now = false) {
    if (this.#closed) return;
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => this.#fire(), now ? 0 : SETTLE_MS);
    this.#deadline ??= setTimeout(() => this.#fire(), MAX_WAIT_MS);
  }

  #fire() {
    clearTimeout(this.#settle);
    clearTimeout(this.#deadline);
    this.#settle = this.#deadline = undefined;
    void this.rescan();
  }

  /** List the folder now and report what changed. Calls that overlap a listing run one more after it. */
  rescan(): Promise<void> {
    if (this.#scanning) {
      this.#again = true;
      return this.#scanning;
    }
    this.#scanning = (async () => {
      try {
        do {
          this.#again = false;
          if (!this.#watcher) {
            mkdirSync(this.folder, { recursive: true });
            this.#watch();
          }
          const next = await scan(this.folder);
          if (this.#closed) return;
          const changes = this.#known ? diff(this.#known, next.files) : [];
          const first = this.#listing === EMPTY;
          if (this.#known && changes.length === 0) {
            this.#listing = next;
            if (first) this.#onChange(next, undefined);
            continue;
          }
          const entry = this.#store.recordFiles(this.bot, next.files, changes);
          this.#known = next.files;
          this.#listing = next;
          this.#onChange(next, entry);
        } while (this.#again && !this.#closed);
      } catch (error) {
        if (!this.#closed) console.error(`[top] listing ${this.folder}:`, error);
      } finally {
        this.#scanning = undefined;
      }
    })();
    return this.#scanning;
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#settle);
    clearTimeout(this.#deadline);
    clearInterval(this.#poll);
    this.#watcher?.close();
    this.#watcher = undefined;
  }
}

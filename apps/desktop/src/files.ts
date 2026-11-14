/**
 * The Files panel's state: whether it's open, how wide, and which file each bot has open in it. The
 * bots' file listings themselves come from the daemon, through `top`.
 */
import { useAtomValue } from "@effect/atom-react";
import type { BotFiles, BotId } from "@top/client";
import * as Atom from "effect/reactivity/Atom";
import { registry, useClient } from "./top.ts";

export const PANEL_MIN = 300;
export const PANEL_DEFAULT = 460;

type PanelState = {
  readonly open: boolean;
  readonly width: number;
  /** The file each bot has open in the panel; none shows the list. */
  readonly selected: Readonly<Record<BotId, string | undefined>>;
};

function read(): PanelState {
  try {
    const saved = JSON.parse(localStorage.getItem("top.filesPanel") ?? "{}") as { open?: boolean; width?: number };
    return { open: saved.open === true, width: Number(saved.width) || PANEL_DEFAULT, selected: {} };
  } catch {
    return { open: false, width: PANEL_DEFAULT, selected: {} };
  }
}

const panelAtom = Atom.make(read()).pipe(Atom.keepAlive);

function set(change: Partial<PanelState>) {
  const state = { ...registry.get(panelAtom), ...change };
  registry.set(panelAtom, state);
  try {
    localStorage.setItem("top.filesPanel", JSON.stringify({ open: state.open, width: state.width }));
  } catch {
    // disabled storage: the panel just won't remember
  }
}

export function usePanel(): PanelState {
  return useAtomValue(panelAtom);
}

export const togglePanel = () => set({ open: !registry.get(panelAtom).open });
export const closePanel = () => set({ open: false });
export const setPanelWidth = (width: number) => set({ width: Math.round(width) });

/** Open one of a bot's files in the panel (opening the panel if it's closed). */
export function openFile(bot: BotId, path: string) {
  set({ open: true, selected: { ...registry.get(panelAtom).selected, [bot]: path } });
}

/** Back to the bot's list of files. */
export function showList(bot: BotId) {
  set({ selected: { ...registry.get(panelAtom).selected, [bot]: undefined } });
}

/** A bot's files, once the daemon has listed them. */
export function useBotFiles(bot: BotId | undefined): BotFiles | undefined {
  return useClient((snapshot) => (bot === undefined ? undefined : snapshot.files[bot]));
}

// ── what a file is ────────────────────────────────────────────────────────────

export type FileKind = "html" | "markdown" | "image" | "pdf" | "video" | "audio" | "table" | "text" | "other";

const KINDS: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => {
  for (const ext of exts.split(" ")) KINDS[ext] = kind;
};
add("html", "html htm");
add("markdown", "md markdown");
add("image", "png jpg jpeg gif webp avif svg bmp ico");
add("pdf", "pdf");
add("video", "mp4 webm mov");
add("audio", "mp3 wav ogg m4a");
add("table", "csv tsv");
add(
  "text",
  "txt log json jsonl xml yaml yml toml ini cfg conf env css js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh ps1 sql diff patch lua r jl scala dart vue svelte mmd",
);

export const extOf = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
export const kindOf = (path: string): FileKind => KINDS[extOf(path)] ?? "other";
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The file's absolute path on the daemon's computer, with that computer's separators. */
export function localPath(files: BotFiles, path: string): string {
  const windows = files.folder.includes("\\") && !files.folder.includes("/");
  const sep = windows ? "\\" : "/";
  return `${files.folder.replace(/[\\/]+$/, "")}${sep}${windows ? path.replaceAll("/", "\\") : path}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "just now", "5 min ago", "3 h ago", or the date. */
export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: new Date(at).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

// A driver for `pnpm screenshot` and `pnpm bench`, like `__topSelect`.
(window as unknown as { __topFiles: unknown }).__topFiles = { openFile, showList, togglePanel };

import { useAtomValue } from "@effect/atom-react";
import type { BotFiles, BotId } from "@top/client";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { registry, useClient } from "./top.ts";

export const PANEL_MIN = 300;
export const PANEL_DEFAULT = 460;

type PanelState = {
  readonly open: boolean;
  readonly width: number;
  readonly selected: Readonly<Record<BotId, string | undefined>>;
};

const SavedPanel = Schema.fromJsonString(Schema.Struct({ open: Schema.optionalKey(Schema.Boolean), width: Schema.optionalKey(Schema.Number) }));
const readSaved = Schema.decodeOption(SavedPanel);

function read(): PanelState {
  let saved: typeof SavedPanel.Type | undefined;
  try {
    saved = Option.getOrUndefined(readSaved(localStorage.getItem("top.filesPanel") ?? "{}"));
  } catch {}
  return { open: saved?.open === true, width: saved?.width || PANEL_DEFAULT, selected: {} };
}

const panelAtom = Atom.make(read()).pipe(Atom.keepAlive);

function set(change: Partial<PanelState>) {
  const state = { ...registry.get(panelAtom), ...change };
  registry.set(panelAtom, state);
  try {
    localStorage.setItem("top.filesPanel", JSON.stringify({ open: state.open, width: state.width }));
  } catch {}
}

export function usePanel(): PanelState {
  return useAtomValue(panelAtom);
}

export const togglePanel = () => set({ open: !registry.get(panelAtom).open });
export const closePanel = () => set({ open: false });
export const setPanelWidth = (width: number) => set({ width: Math.round(width) });

export function openFile(bot: BotId, path: string) {
  set({ open: true, selected: { ...registry.get(panelAtom).selected, [bot]: path } });
}

export function showList(bot: BotId) {
  set({ selected: { ...registry.get(panelAtom).selected, [bot]: undefined } });
}

export function useBotFiles(bot: BotId | undefined): BotFiles | undefined {
  return useClient((snapshot) => (bot === undefined ? undefined : snapshot.files[bot]));
}

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

declare global {
  interface Window {
    __topFiles?: { readonly openFile: typeof openFile; readonly showList: typeof showList; readonly togglePanel: typeof togglePanel };
  }
}
window.__topFiles = { openFile, showList, togglePanel };

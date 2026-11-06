/**
 * The Files panel, beside the transcript: the open bot's files folder, newest first, and the file you
 * opened, rendered. Each file can be handed elsewhere: its path on the daemon's computer (for agents
 * there, which can read and edit it) or its link on the address this app reaches the daemon at (for
 * a browser, or anything on another machine, over Tailscale or a tunnel too).
 */
import type { BotFiles, BotId, FileView } from "@top/client";
import { Check, ChevronLeft, Copy, ExternalLink, FolderOpen, Link, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  closePanel,
  dirOf,
  formatAgo,
  formatSize,
  kindOf,
  localPath,
  nameOf,
  openFile,
  PANEL_DEFAULT,
  PANEL_MIN,
  setPanelWidth,
  showList,
  useBotFiles,
  usePanel,
} from "../../files.ts";
import { cn } from "../../lib/utils.ts";
import { top } from "../../top.ts";
import { Button } from "../ui/button.tsx";
import { Tooltip } from "../ui/tooltip.tsx";
import { FileIcon } from "./FileIcon.tsx";
import { Notice, VIEWERS } from "./viewers.tsx";

/** "Copied" for a moment after `copy` runs. */
function useCopy(): [string | undefined, (what: string, text: string) => void] {
  const [copied, setCopied] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((what: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(undefined), 1_400);
    });
  }, []);
  return [copied, copy];
}

function IconAction({ label, onClick, children, className }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip content={label} side="bottom">
      <Button variant="ghost" size="icon" className={cn("size-8", className)} onClick={onClick} aria-label={label}>
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * The panel's top bar, the height of the transcript's header. On Windows and Linux the window buttons
 * sit over its right end, so everything here stays at the left, clear of them: no second close button
 * beside the window's, and nothing at a slightly different height next to them.
 */
function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="flex h-15 flex-none items-center gap-1 border-b pr-3 pl-2 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      {children}
    </header>
  );
}

/** Closes the panel where it covers the whole window (narrow ones); elsewhere the header's Files button does. */
function NarrowClose() {
  return (
    <IconAction label="Close files" onClick={closePanel} className="hidden narrow:inline-flex">
      <X size={17} />
    </IconAction>
  );
}

/** Drag the panel's left edge to resize it; double-click to put it back. */
function ResizeHandle({ width }: { width: number }) {
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    // Pages in frames would swallow the pointer while dragging over them.
    document.documentElement.classList.add("resizing");
    const move = (e: PointerEvent) => setPanelWidth(Math.min(Math.max(PANEL_MIN, width + startX - e.clientX), innerWidth * 0.75));
    const up = () => {
      document.documentElement.classList.remove("resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only affordance; the width also has a sensible default
    <div
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring narrow:hidden"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
    />
  );
}

// ── the list ──────────────────────────────────────────────────────────────────

const FileRow = memo(function FileRow({ bot, file, now }: { bot: BotId; file: FileView; now: number }) {
  const dir = dirOf(file.path);
  return (
    <button
      type="button"
      className="group/file flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-90 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      onClick={() => openFile(bot, file.path)}
      title={file.path}
    >
      <span className="grid size-8 flex-none place-items-center rounded-md bg-muted text-secondary-foreground inset-ring inset-ring-border">
        <FileIcon path={file.path} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-small leading-snug font-label text-foreground">{nameOf(file.path)}</span>
        <span className="truncate text-meta text-muted-foreground">
          {dir && <>{dir}/ · </>}
          {formatSize(file.size)} · {formatAgo(file.mtime, now)}
        </span>
      </span>
    </button>
  );
});

function FileList({ bot, name, files }: { bot: BotId; name: string; files: BotFiles | undefined }) {
  const [copied, copy] = useCopy();
  // Times are relative; refresh them now and then.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sorted = files ? [...files.files].sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1)) : [];
  return (
    <>
      <PanelHeader>
        <NarrowClose />
        <div className="flex min-w-0 items-baseline gap-2 pr-1 pl-2.5">
          <h2 className="m-0 text-base leading-tight font-heading tracking-name">Files</h2>
          {files && files.files.length > 0 && <span className="text-meta text-muted-foreground tabular-nums">{files.files.length}</span>}
        </div>
        {files && (
          <IconAction label={copied === "folder" ? "Copied" : "Copy folder path"} onClick={() => copy("folder", files.folder)}>
            {copied === "folder" ? <Check size={16} /> : <FolderOpen size={16} />}
          </IconAction>
        )}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [scrollbar-gutter:stable]">
        {!files ? (
          <Notice>Waiting for the daemon…</Notice>
        ) : sorted.length === 0 ? (
          <Notice className="flex-col gap-2">
            <span className="font-label text-secondary-foreground">No files yet</span>
            <span>Pages, reports and images {name} makes for you show up here. Ask for one, or put files in its folder yourself:</span>
            <button
              type="button"
              className="mt-1 max-w-full truncate rounded-md bg-code px-2 py-1 font-mono text-micro text-code-foreground hover:bg-secondary"
              onClick={() => copy("folder", files.folder)}
              title="Copy the folder's path"
            >
              {copied === "folder" ? "Copied" : files.folder}
            </button>
          </Notice>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sorted.map((file) => (
              <FileRow key={file.path} bot={bot} file={file} now={now} />
            ))}
            {files.more && (
              <p className="px-2.5 py-2 text-meta text-muted-foreground">
                The folder has more files than this; only the first {files.files.length.toLocaleString()} are listed.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── one file ──────────────────────────────────────────────────────────────────

function FileViewer({ bot, path, files }: { bot: BotId; path: string; files: BotFiles | undefined }) {
  const [copied, copy] = useCopy();
  const file = files?.files.find((f) => f.path === path);
  const url = top.fileUrl(bot, path);
  const Viewer = VIEWERS[kindOf(path)];
  const dir = dirOf(path);
  return (
    <>
      <PanelHeader>
        <IconAction label="All files" onClick={() => showList(bot)}>
          <ChevronLeft size={18} />
        </IconAction>
        <div className="flex min-w-0 flex-col pr-1.5" title={path}>
          <span className="truncate text-small leading-tight font-label">{nameOf(path)}</span>
          <span className="truncate text-micro leading-snug text-muted-foreground">
            {dir ? `${dir}/ · ` : ""}
            {file ? `${formatSize(file.size)} · ${formatAgo(file.mtime)}` : "Removed"}
          </span>
        </div>
        <span className="h-5 w-px flex-none bg-border" aria-hidden />
        {files && (
          <IconAction label={copied === "path" ? "Copied" : "Copy path"} onClick={() => copy("path", localPath(files, path))}>
            {copied === "path" ? <Check size={16} /> : <Copy size={16} />}
          </IconAction>
        )}
        {url && (
          <>
            <IconAction label={copied === "link" ? "Copied" : "Copy link"} onClick={() => copy("link", url)}>
              {copied === "link" ? <Check size={16} /> : <Link size={16} />}
            </IconAction>
            <IconAction label="Open in browser" onClick={() => window.open(url, "_blank", "noopener")}>
              <ExternalLink size={16} />
            </IconAction>
          </>
        )}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {!files ? (
          <Notice>Waiting for the daemon…</Notice>
        ) : !file ? (
          <Notice>This file isn't in the folder any more.</Notice>
        ) : !url ? (
          <Notice>This daemon doesn't serve files.</Notice>
        ) : Viewer ? (
          <Viewer bot={bot} path={path} url={url} version={file.mtime} size={file.size} />
        ) : (
          <Notice className="flex-col gap-3">
            No preview for this kind of file.
            <Button variant="outline" onClick={() => window.open(url, "_blank", "noopener")}>
              <ExternalLink size={15} /> Open in browser
            </Button>
          </Notice>
        )}
      </div>
    </>
  );
}

export const FilesPanel = memo(function FilesPanel({ bot, name }: { bot: BotId; name: string }) {
  const panel = usePanel();
  const files = useBotFiles(bot);
  const selected = panel.selected[bot];
  return (
    <aside
      className="relative flex min-h-0 min-w-0 flex-col border-l bg-background narrow:absolute narrow:inset-0 narrow:z-50 narrow:w-auto! narrow:border-l-0"
      style={{ width: panel.width }}
      aria-label="Files"
    >
      <ResizeHandle width={panel.width} />
      {selected ? <FileViewer bot={bot} path={selected} files={files} /> : <FileList bot={bot} name={name} files={files} />}
    </aside>
  );
});

/** For the header's toggle: how many files the bot has, or `undefined` when this daemon has no files. */
export function useFileCount(bot: BotId | undefined): number | undefined {
  return useBotFiles(bot)?.files.length;
}

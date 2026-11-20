import type { BotFiles, BotId, FileView } from "@top/client";
import { Check, ChevronLeft, Copy, ExternalLink, FolderOpen, Link, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  closeFiles,
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
import { type PanelLayout, panelMax } from "../../panelLayout.ts";
import { top } from "../../top.ts";
import { Button } from "../ui/button.tsx";
import { Tooltip } from "../ui/tooltip.tsx";
import { FileIcon } from "./FileIcon.tsx";
import { Notice, VIEWERS } from "./viewers.tsx";

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

/** The panel's header; its right end stays clear for the Files button, which sits over it at the window's corner. */
function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="@container flex h-15 flex-none items-center gap-1 border-b pr-[calc(var(--titlebar-inset)+5rem)] pl-2 [-webkit-app-region:drag] narrow:pr-[calc(var(--titlebar-inset)+4rem)] [&_button]:[-webkit-app-region:no-drag]">
      {children}
      <span className="flex-1" />
      <IconAction label="Close files (Esc)" onClick={closeFiles} className="narrow:size-11">
        <X size={17} />
      </IconAction>
    </header>
  );
}

const RESIZE_STEP = 24;

function ResizeHandle({ width }: { width: number }) {
  const clamp = (w: number) => Math.min(Math.max(PANEL_MIN, w), panelMax(innerWidth));
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    document.documentElement.classList.add("resizing");
    const move = (e: PointerEvent) => setPanelWidth(clamp(width + startX - e.clientX));
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
  const onKeyDown = (event: React.KeyboardEvent) => {
    const by = { ArrowLeft: RESIZE_STEP, ArrowRight: -RESIZE_STEP }[event.key];
    if (by !== undefined) setPanelWidth(clamp(width + by));
    else if (event.key === "Home") setPanelWidth(panelMax(innerWidth));
    else if (event.key === "End") setPanelWidth(PANEL_MIN);
    else if (event.key === "Enter") setPanelWidth(PANEL_DEFAULT);
    else return;
    event.preventDefault();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the resize handle pattern; <hr> can't take focus or a pointer drag
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize files"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={panelMax(innerWidth)}
      aria-valuenow={width}
      tabIndex={0}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-hidden after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-primary"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
    />
  );
}

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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sorted = files ? [...files.files].sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1)) : [];
  return (
    <>
      <PanelHeader>
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
        <span className="h-5 w-px flex-none bg-border @max-xs:hidden" aria-hidden />
        {files && (
          <IconAction label={copied === "path" ? "Copied" : "Copy path"} onClick={() => copy("path", localPath(files, path))}>
            {copied === "path" ? <Check size={16} /> : <Copy size={16} />}
          </IconAction>
        )}
        {url && (
          <>
            {/* Under 320px there's no room for it beside Close and the Files button; Open in browser has the link too. */}
            <IconAction label={copied === "link" ? "Copied" : "Copy link"} onClick={() => copy("link", url)} className="@max-xs:hidden">
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

export const FilesPanel = memo(function FilesPanel({ bot, name, layout }: { bot: BotId; name: string; layout: PanelLayout }) {
  const panel = usePanel();
  const files = useBotFiles(bot);
  const selected = panel.selected[bot];
  const ref = useRef<HTMLElement>(null);
  const { overlay } = layout;

  // Over the conversation, the panel takes focus and Esc closes it; beside it, Esc does when focus is in the panel.
  useEffect(() => {
    if (overlay && !ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>('[aria-label^="Close files"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog], [role=menu]")) return;
      if (!overlay && !ref.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      closeFiles();
    };
    addEventListener("keydown", onKey, { capture: true });
    return () => removeEventListener("keydown", onKey, { capture: true });
  }, [overlay]);

  return (
    <aside
      ref={ref}
      id="files-panel"
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background",
        overlay
          ? "absolute inset-y-0 right-0 z-20 border-l shadow-popover narrow:border-l-0 narrow:shadow-none"
          : "relative max-w-[calc(100vw-var(--sidebar-width)-var(--chat-min))] border-l",
      )}
      style={{ width: layout.width }}
      aria-label="Files"
    >
      {!overlay && <ResizeHandle width={layout.width} />}
      {selected ? <FileViewer bot={bot} path={selected} files={files} /> : <FileList bot={bot} name={name} files={files} />}
    </aside>
  );
});

export function useFileCount(bot: BotId | undefined): number | undefined {
  return useBotFiles(bot)?.files.length;
}

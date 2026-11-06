/**
 * How each kind of file shows in the Files panel. Pages, PDFs and media load straight from the
 * daemon's file link; Markdown, tables and text are fetched and rendered here, in the app's theme.
 *
 * An HTML page runs in a sandboxed frame with the daemon's address as its origin: its scripts run, but
 * it can't reach the app (another origin), navigate the window, or use the daemon's WebSocket (which
 * refuses that origin).
 */
import type { BotId } from "@top/client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extOf, type FileKind, formatSize, openFile } from "../../files.ts";
import { copyCode } from "../../lib/copyCode.ts";
import { cn } from "../../lib/utils.ts";
import { highlight, renderMarkdown } from "../../markdown.ts";
import { top } from "../../top.ts";
import { Markdown } from "../transcript/parts.tsx";

/** Bigger text files aren't fetched: the panel would stall on them. */
const MAX_TEXT = 2 * 1024 * 1024;
/** Highlighting is for code you read, not for megabytes of it. */
const MAX_HIGHLIGHT = 200 * 1024;
const MAX_TABLE_ROWS = 1_000;

export type ViewerProps = {
  readonly bot: BotId;
  readonly path: string;
  readonly url: string;
  /** Changes when the file does, to load it again. */
  readonly version: number;
  readonly size: number;
};

type Loaded = { state: "loading" } | { state: "ok"; text: string } | { state: "error"; error: string };

/** The file's text, fetched again whenever `version` changes. */
function useText(url: string, version: number, size: number): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the file's mtime; a new one means new content at the same URL
  useEffect(() => {
    if (size > MAX_TEXT) {
      setLoaded({ state: "error", error: `This file is ${formatSize(size)}, too big to show here.` });
      return;
    }
    const abort = new AbortController();
    fetch(url, { signal: abort.signal, cache: "no-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "This file isn't there any more." : `The daemon answered ${response.status}.`);
        setLoaded({ state: "ok", text: await response.text() });
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setLoaded({ state: "error", error: error.message || "Couldn't load the file." });
      });
    return () => abort.abort();
  }, [url, version, size]);
  return loaded;
}

export function Notice({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex h-full items-center justify-center p-8 text-center text-small text-muted-foreground", className)}>{children}</div>;
}

function Status({ loaded }: { loaded: Exclude<Loaded, { state: "ok" }> }) {
  return <Notice>{loaded.state === "loading" ? "Loading…" : loaded.error}</Notice>;
}

// ── pages, PDFs, media ────────────────────────────────────────────────────────

const HtmlView = memo(function HtmlView({ url, version, path }: ViewerProps) {
  return (
    <iframe
      // A new version reloads the page (the daemon says "no-cache", so it's fetched again).
      key={version}
      title={path}
      src={url}
      className="size-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
      allow="fullscreen; clipboard-write"
    />
  );
});

// Chromium's PDF viewer doesn't run in a sandboxed frame; a PDF can't script the page anyway.
const PdfView = memo(function PdfView({ url, version, path }: ViewerProps) {
  return <iframe key={version} title={path} src={url} className="size-full border-0" />;
});

const ImageView = memo(function ImageView({ url, version, path }: ViewerProps) {
  return (
    <div className="checkerboard flex min-h-full items-center justify-center p-4">
      <img src={`${url}?v=${version}`} alt={path} className="max-w-full object-contain shadow-sm" />
    </div>
  );
});

const VideoView = memo(function VideoView({ url, version }: ViewerProps) {
  // biome-ignore lint/a11y/useMediaCaption: a bot's own video has no captions to offer
  return <video key={version} src={url} controls className="size-full bg-black object-contain" />;
});

const AudioView = memo(function AudioView({ url, version }: ViewerProps) {
  return (
    <Notice>
      {/* biome-ignore lint/a11y/useMediaCaption: a bot's own audio has no captions to offer */}
      <audio key={version} src={url} controls className="w-full max-w-120" />
    </Notice>
  );
});

// ── Markdown, with Mermaid diagrams ───────────────────────────────────────────

type Mermaid = typeof import("mermaid")["default"];
let mermaid: Promise<Mermaid> | undefined;
let diagrams = 0;

/** Replace the `mermaid` code blocks under `root` with their diagrams. Mermaid loads the first time one is needed. */
async function renderDiagrams(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>(".code")].filter((block) => block.querySelector(".code-head span")?.textContent === "mermaid");
  if (!blocks.length) return;
  mermaid ??= import("mermaid").then((module) => module.default);
  let lib: Mermaid;
  try {
    lib = await mermaid;
  } catch (error) {
    mermaid = undefined;
    for (const block of blocks) block.before(diagramError(`Couldn't load the diagram renderer: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  lib.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: getComputedStyle(root).fontFamily });
  for (const block of blocks) {
    if (!block.isConnected) continue;
    const source = block.querySelector("code")?.textContent ?? "";
    try {
      // `parse` throws on a mistake without leaving an error diagram in the page, as `render` would.
      await lib.parse(source);
      const { svg } = await lib.render(`top-mermaid-${++diagrams}`, source);
      if (!block.isConnected) continue;
      const figure = document.createElement("div");
      figure.className = "mermaid-diagram";
      figure.innerHTML = svg;
      block.replaceWith(figure);
    } catch (error) {
      block.before(diagramError(`This diagram didn't render: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`));
    }
  }
}

function diagramError(text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "mermaid-error";
  note.textContent = text;
  return note;
}

/**
 * Markdown rendered as the transcript renders it. Relative images load from the bot's folder, and a
 * relative link to another of its files opens that file here.
 */
function rewriteLinks(html: string, url: string, bot: BotId): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const base = top.fileUrl(bot, "") ?? "";
  for (const img of template.content.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", new URL(src, url).href);
  }
  for (const link of template.content.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
    const target = new URL(href, url);
    if (base && target.href.startsWith(base)) {
      link.setAttribute("data-file", decodeURIComponent(target.pathname.slice(new URL(base).pathname.length)));
      link.removeAttribute("target");
    }
    link.setAttribute("href", target.href);
  }
  return template.innerHTML;
}

const MarkdownView = memo(function MarkdownView({ bot, url, version, size }: ViewerProps) {
  const loaded = useText(url, version, size);
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (loaded.state === "ok" ? rewriteLinks(renderMarkdown(loaded.text), url, bot) : ""), [loaded, url, bot]);
  useEffect(() => {
    const root = ref.current;
    if (html && root)
      renderDiagrams(root).catch((error) => root.prepend(diagramError(`Diagrams didn't render: ${error instanceof Error ? error.message : String(error)}`)));
  }, [html]);
  const onClick = useCallback(
    (event: React.MouseEvent) => {
      if (copyCode(event)) return;
      const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-file]");
      if (!link) return;
      event.preventDefault();
      openFile(bot, link.dataset.file!);
    },
    [bot],
  );
  if (loaded.state !== "ok") return <Status loaded={loaded} />;
  return (
    // Delegated: the copy buttons in code blocks and links to other files are real buttons and links.
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: delegation, see above
    <div ref={ref} className="file-md mx-auto max-w-200 px-7 pt-5 pb-10" onClick={onClick}>
      <Markdown html={html} />
    </div>
  );
});

// ── tables and text ───────────────────────────────────────────────────────────

/** CSV or TSV rows: quoted fields may hold separators, quotes ("") and line breaks. */
export function parseTable(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > MAX_TABLE_ROWS) break;
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const TableView = memo(function TableView({ path, url, version, size }: ViewerProps) {
  const loaded = useText(url, version, size);
  const rows = useMemo(() => (loaded.state === "ok" ? parseTable(loaded.text, extOf(path) === "tsv" ? "\t" : ",") : []), [loaded, path]);
  if (loaded.state !== "ok") return <Status loaded={loaded} />;
  const [head = [], ...body] = rows;
  const shown = body.slice(0, MAX_TABLE_ROWS);
  return (
    <div className="md file-table p-4">
      <table>
        <thead>
          <tr>
            {head.map((cell, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their place
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
            <tr key={r}>
              {row.map((cell, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: as above
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_TABLE_ROWS && <p className="pt-3 text-meta text-muted-foreground">Showing the first {MAX_TABLE_ROWS.toLocaleString()} rows.</p>}
    </div>
  );
});

const TextView = memo(function TextView({ path, url, version, size }: ViewerProps) {
  const loaded = useText(url, version, size);
  const html = useMemo(() => {
    if (loaded.state !== "ok") return "";
    const ext = extOf(path);
    return highlight(loaded.text, loaded.text.length <= MAX_HIGHLIGHT ? ext : "");
  }, [loaded, path]);
  if (loaded.state !== "ok") return <Status loaded={loaded} />;
  return (
    <pre className="file-text m-0 min-h-full px-5 py-4 font-mono text-code whitespace-pre-wrap text-code-foreground [overflow-wrap:anywhere]">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: hljs escapes the text */}
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
});

export const VIEWERS: Partial<Record<FileKind, React.ComponentType<ViewerProps>>> = {
  html: HtmlView,
  pdf: PdfView,
  image: ImageView,
  video: VideoView,
  audio: AudioView,
  markdown: MarkdownView,
  table: TableView,
  text: TextView,
};

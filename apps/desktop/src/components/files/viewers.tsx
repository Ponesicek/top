import type { BotId } from "@top/client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { extOf, type FileKind, formatSize, openFile } from "../../files.ts";
import { copyCode } from "../../lib/copyCode.ts";
import { cn } from "../../lib/utils.ts";
import { LiveFrames } from "../../liveFrame.ts";
import { highlight, renderMarkdown } from "../../markdown.ts";
import { top } from "../../top.ts";
import { Markdown } from "../transcript/parts.tsx";

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_HIGHLIGHT = 200 * 1024;
const MAX_TABLE_ROWS = 1_000;

export type ViewerProps = {
  readonly bot: BotId;
  readonly path: string;
  readonly url: string;
  readonly version: number;
  readonly size: number;
};

type Loaded = { state: "loading" } | { state: "ok"; text: string } | { state: "error"; error: string };

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

async function readBytes(url: string): Promise<Uint8Array | undefined> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    void response.body?.cancel();
    return undefined;
  }
  return new Uint8Array(await response.arrayBuffer());
}

function LiveFrame({
  url,
  src = url,
  version,
  title,
  className,
  ...rest
}: { url: string; version: number; title: string; className: string } & Omit<React.ComponentProps<"iframe">, "onLoad">) {
  const [live] = useState(() => new LiveFrames(version, () => readBytes(url)));
  useEffect(() => () => live.dispose(), [live]);
  useEffect(() => live.show(version), [live, version]);
  const frames = useSyncExternalStore(live.subscribe, live.frames);
  return (
    <div className="relative size-full">
      {frames.map((frame) => (
        <iframe
          key={frame.key}
          title={title}
          src={src}
          className={cn("absolute inset-0 size-full border-0", className, !frame.shown && "invisible")}
          aria-hidden={!frame.shown || undefined}
          tabIndex={frame.shown ? undefined : -1}
          onLoad={() => live.loaded(frame.key)}
          {...rest}
        />
      ))}
    </div>
  );
}

const HtmlView = memo(function HtmlView({ url, version, path }: ViewerProps) {
  return (
    <LiveFrame
      key={url}
      url={url}
      src={`${url}?frame`}
      version={version}
      title={path}
      className="bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
      allow="fullscreen; clipboard-write"
    />
  );
});

const PdfView = memo(function PdfView({ url, version, path }: ViewerProps) {
  return <LiveFrame key={url} url={url} version={version} title={path} className="" />;
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

type Mermaid = typeof import("mermaid")["default"];
let mermaid: Promise<Mermaid> | undefined;
let diagrams = 0;

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
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: delegation, see above
    <div ref={ref} className="file-md mx-auto max-w-200 px-7 pt-5 pb-10" onClick={onClick}>
      <Markdown html={html} />
    </div>
  );
});

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

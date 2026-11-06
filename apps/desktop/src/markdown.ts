/**
 * Markdown for model output. Raw HTML is off (model text is untrusted), links open outside the app,
 * and finished messages are rendered once and cached by entry ID.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import MarkdownIt from "markdown-it";

// A handful of languages the bots actually write; anything else stays plain.
for (const [name, lang] of Object.entries({ bash, css, diff, go, javascript, json, python, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang);
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

/** Highlighted HTML (hljs escapes the text), or escaped plain text for unknown languages. */
function highlight(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain text
    }
  }
  return md.utils.escapeHtml(code);
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
// Bare emails stay text, as they do in tool steps; URLs still link.
md.linkify.set({ fuzzyEmail: false });

const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noreferrer noopener");
  return defaultLink(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = md.utils.escapeHtml(token.info.trim().split(/\s+/)[0] ?? "");
  const code = highlight(token.content, token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
  return `<div class="code"><div class="code-head"><span>${lang || "text"}</span><button class="copy" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span>Copy</span></button></div><pre><code>${code}</code></pre></div>`;
};

// Numeric table columns (all body cells like "12", "6.1 ms", "41%") are right-aligned with tabular digits.
const NUMERIC = /^[-+]?[\d.,]+\s*(%|ms|s|x|kb|mb|gb)?$/i;
md.core.ruler.push("numeric_columns", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== "table_open") continue;
    const cells: { open: (typeof tokens)[number]; col: number; body: boolean; text: string }[] = [];
    let col = 0;
    let body = false;
    let j = i + 1;
    for (; j < tokens.length && tokens[j]!.type !== "table_close"; j++) {
      const t = tokens[j]!;
      if (t.type === "tbody_open") body = true;
      else if (t.type === "tr_open") col = 0;
      else if (t.type === "th_open" || t.type === "td_open") cells.push({ open: t, col: col++, body, text: tokens[j + 1]?.content.trim() ?? "" });
    }
    const columns = new Set(cells.map((c) => c.col));
    for (const c of columns) {
      const values = cells.filter((x) => x.col === c && x.body);
      if (values.length && values.every((x) => NUMERIC.test(x.text))) for (const x of cells) if (x.col === c) x.open.attrJoin("class", "num");
    }
    i = j;
  }
});

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  return md.render(text);
}

/** Immutable text (a committed entry): rendered once. */
export function renderCached(key: string, text: string): string {
  let html = cache.get(key);
  if (html === undefined) {
    html = md.render(text);
    cache.set(key, html);
    if (cache.size > 5_000) cache.delete(cache.keys().next().value!);
  }
  return html;
}

export type Segment = { readonly kind: "prose" | "block"; readonly html: string };
const segmentCache = new Map<string, Segment[]>();

/**
 * A rendered answer cut into runs of prose and the tables and code blocks between them, for styles
 * that put prose in bubbles and let wide blocks stand on their own.
 */
export function renderSegments(key: string, text: string): Segment[] {
  let segments = segmentCache.get(key);
  if (segments) return segments;
  const template = document.createElement("template");
  template.innerHTML = renderCached(key, text);
  segments = [];
  let prose = "";
  const flush = () => {
    if (prose.trim()) segments!.push({ kind: "prose", html: prose });
    prose = "";
  };
  for (const node of Array.from(template.content.childNodes)) {
    const el = node instanceof Element ? node : null;
    if (el && (el.tagName === "TABLE" || el.classList.contains("code"))) {
      flush();
      segments.push({ kind: "block", html: el.outerHTML });
    } else {
      prose += el ? el.outerHTML : md.utils.escapeHtml(node.textContent ?? "");
    }
  }
  flush();
  segmentCache.set(key, segments);
  if (segmentCache.size > 2_000) segmentCache.delete(segmentCache.keys().next().value!);
  return segments;
}

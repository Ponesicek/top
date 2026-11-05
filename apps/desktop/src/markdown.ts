/**
 * Markdown for model output. Raw HTML is off (model text is untrusted), links open outside the app,
 * and finished messages are rendered once and cached by entry ID.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noreferrer noopener");
  return defaultLink(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = md.utils.escapeHtml(token.info.trim().split(/\s+/)[0] ?? "");
  const code = md.utils.escapeHtml(token.content);
  return `<div class="code"><div class="code-head"><span>${lang || "text"}</span><button class="copy" type="button">Copy</button></div><pre><code>${code}</code></pre></div>`;
};

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

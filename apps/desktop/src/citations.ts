import type { Citation, WebSearchStep } from "@top/client";

// OpenAI's models cite web results with private-use markers like "citeturn949148view0".
// OpenAI turns them into links (url_citation) when the cited result is from the same response. When it's
// from an earlier one, the marker reaches us raw, and nothing says which page "turn949148" was.
const MARKER = /[ \t]*cite(?:[^]*)+/g;

export const hasCitationMarker = (text: string) => text.includes("cite");

/** Drops the citation markers OpenAI left unresolved: they name no page we can show. */
export const withoutCitationMarkers = (text: string) => text.replace(MARKER, "");

function webHref(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A URL to compare pages by: OpenAI tags the links it cites with `utm_source=openai`, the same page opened has no tag. */
export function withoutOpenAiTag(url: string): string {
  const parsed = webHref(url);
  if (!parsed) return url;
  // Deleting re-serializes the whole query, tagged or not, so both sides of a comparison come out the same.
  parsed.searchParams.delete("utm_source", "openai");
  return parsed.href;
}

function pageTitle(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).at(-1);
  const host = url.hostname.replace(/^www\./, "");
  try {
    return (last && decodeURIComponent(last)) || host;
  } catch {
    return last || host;
  }
}

/** The pages the bot opened, in order and once each, from its web search steps. Failed opens aren't pages it read. */
export function pagesOpened(steps: readonly WebSearchStep[]): Citation[] {
  const pages = new Map<string, Citation>();
  for (const step of steps) {
    const url = step.action === "open_page" && !step.failed && step.url ? webHref(step.url) : undefined;
    if (url && !pages.has(url.href)) pages.set(url.href, { url: url.href, title: pageTitle(url) });
  }
  return [...pages.values()];
}

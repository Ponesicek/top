import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Etag from "effect/http/Etag";
import type * as HttpPlatform from "effect/http/HttpPlatform";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export type FileServing = FileSystem.FileSystem | Etag.Generator | HttpPlatform.HttpPlatform;

export class NotFound extends Data.TaggedError("NotFound")<{ readonly path: string }> {}

const matches = (header: string | undefined, etag: string) => {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
};

export const sendFile = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  extra: Record<string, string>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFound, FileServing> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.mapError(() => new NotFound({ path })));
    if (info.type !== "File") return yield* new NotFound({ path });
    const etag = Etag.toString(yield* (yield* Etag.Generator).fromFileInfo(info));
    const size = Number(info.size);
    const headers: Record<string, string> = {
      ...extra,
      "Accept-Ranges": "bytes",
      "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range",
    };
    if (matches(request.headers["if-none-match"], etag)) return HttpServerResponse.empty({ status: 304, headers: { ...headers, ETag: etag } });
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size)
        return HttpServerResponse.empty({ status: 416, headers: { ...headers, ETag: etag, "Content-Range": `bytes */${size}` } });
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    }
    const length = size === 0 ? 0 : end - start + 1;
    if (request.method === "HEAD" || size === 0)
      return HttpServerResponse.empty({ status, headers: { ...headers, ETag: etag, "Content-Length": String(length) } });
    return yield* HttpServerResponse.file(path, { status, headers, offset: start, bytesToRead: length }).pipe(Effect.mapError(() => new NotFound({ path })));
  });

export const KEEP_SCROLL_SCRIPT =
  `(()=>{try{if(parent===window)return;const k="top-scroll:"+location.pathname,s=sessionStorage;let ready=false;` +
  `addEventListener("scroll",()=>{if(ready)s.setItem(k,scrollX+" "+scrollY)},{passive:true});` +
  `addEventListener("load",()=>{const v=(s.getItem(k)||"").split(" ").map(Number);` +
  `if(!scrollX&&!scrollY&&v.length===2&&v.every(Number.isFinite))scrollTo({left:v[0],top:v[1],behavior:"instant"});ready=true})}catch{}})()`;
const KEEP_SCROLL = new TextEncoder().encode(`<script>${KEEP_SCROLL_SCRIPT}</script>`);
const MAX_FRAMED = 16 * 1024 * 1024;

export function keepScroll(page: Uint8Array): Uint8Array {
  if ((page[0] === 0xff && page[1] === 0xfe) || (page[0] === 0xfe && page[1] === 0xff)) return page;
  const start = new TextDecoder("latin1").decode(page.subarray(0, 4096));
  const bom = start.startsWith("\u00EF\u00BB\u00BF") ? 3 : 0;
  const anchor = /<head(?:\s[^>]*)?>/i.exec(start) ?? /<!doctype[^>]*>/i.exec(start);
  const at = anchor ? anchor.index + anchor[0].length : bom;
  const out = new Uint8Array(page.length + KEEP_SCROLL.length);
  out.set(page.subarray(0, at));
  out.set(KEEP_SCROLL, at);
  out.set(page.subarray(at), at + KEEP_SCROLL.length);
  return out;
}

export const sendFramedPage = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
  extra: Record<string, string>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFound, FileServing> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(Effect.mapError(() => new NotFound({ path })));
    if (info.type !== "File") return yield* new NotFound({ path });
    if (request.method === "HEAD" || Number(info.size) > MAX_FRAMED) return yield* sendFile(request, path, extra);
    const { "Content-Type": contentType, ...headers } = extra;
    const page = keepScroll(yield* fs.readFile(path).pipe(Effect.mapError(() => new NotFound({ path }))));
    return HttpServerResponse.uint8Array(page, { status: 200, headers, ...(contentType ? { contentType } : {}) });
  });

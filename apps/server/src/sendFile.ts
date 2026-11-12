/** Sending a file over HTTP, with one byte range (for seeking in video and audio) and ETag revalidation. */
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export function sendFile(request: IncomingMessage, response: ServerResponse, path: string, info: Stats, headers: Record<string, string>) {
  const etag = `"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}"`;
  headers = { ...headers, ETag: etag, "Accept-Ranges": "bytes", "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range" };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    return response.end();
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` });
      return response.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["Content-Length"] = String(info.size === 0 ? 0 : end - start + 1);
  response.writeHead(status, headers);
  if (request.method === "HEAD" || info.size === 0) return response.end();
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

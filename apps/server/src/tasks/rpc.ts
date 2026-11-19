import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { redact, tail } from "./harness.ts";

export type RpcId = string | number;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type RpcHandlers = {
  readonly notification: (method: string, params: unknown) => void;
  readonly request: (method: string, params: unknown, id: RpcId) => Promise<unknown>;
  readonly exit: (error: string) => void;
};

const STDERR_KEEP = 4_000;

export class StdioRpc {
  #next = 1;
  readonly #pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #stderr = "";
  #closed = false;

  readonly child: ChildProcessWithoutNullStreams;
  readonly handlers: RpcHandlers;

  constructor(child: ChildProcessWithoutNullStreams, handlers: RpcHandlers) {
    this.child = child;
    this.handlers = handlers;
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => this.#line(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = tail(this.#stderr + chunk, STDERR_KEEP);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.#end(`couldn't run it: ${error.message}`));
    child.on("exit", (code, signal) => this.#end(signal ? `it was killed (${signal})` : `it exited with code ${code}`));
  }

  get stderr(): string {
    return redact(this.#stderr.trim());
  }

  get closed(): boolean {
    return this.#closed;
  }

  #end(why: string) {
    if (this.#closed) return;
    this.#closed = true;
    const detail = this.stderr;
    const error = detail ? `${why}: ${tail(detail, 600)}` : why;
    for (const pending of this.#pending.values()) pending.reject(new RpcError(-32000, error));
    this.#pending.clear();
    this.handlers.exit(error);
  }

  #write(message: unknown) {
    if (this.#closed || !this.child.stdin.writable) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  #line(line: string) {
    if (!line.trim()) return;
    let message: { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (message.method !== undefined && message.id !== undefined) {
      const id = message.id;
      this.handlers.request(message.method, message.params, id).then(
        (result) => this.#write({ id, result }),
        (error: unknown) =>
          this.#write({
            id,
            error: { code: error instanceof RpcError ? error.code : -32603, message: error instanceof Error ? error.message : String(error) },
          }),
      );
      return;
    }
    if (message.method !== undefined) {
      this.handlers.notification(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new RpcError(message.error.code ?? -32603, message.error.message ?? "request failed", message.error.data));
    else pending.resolve(message.result);
  }

  request<A = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<A> {
    return new Promise<A>((resolve, reject) => {
      const id = this.#next++;
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new RpcError(-32001, `${method} got no answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as A);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.#write({ method, id, params })) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new RpcError(-32000, "the harness isn't running"));
      }
    });
  }

  notify(method: string, params: unknown) {
    this.#write({ method, params });
  }

  async close(graceMs = 3_000): Promise<void> {
    if (this.#closed) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), graceMs);
    const hard = setTimeout(() => this.child.kill("SIGKILL"), graceMs * 2);
    await exited;
    clearTimeout(timer);
    clearTimeout(hard);
  }
}

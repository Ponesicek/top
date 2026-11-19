export type Frame = { readonly key: number; readonly shown: boolean };

export type ReadVersion = () => Promise<Uint8Array | undefined>;

export const SWAP_AFTER_MS = 3_000;
export const READ_TIMEOUT_MS = 10_000;

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export class LiveFrames {
  readonly #read: ReadVersion;
  readonly #swapAfterMs: number;
  readonly #readTimeoutMs: number;
  readonly #listeners = new Set<() => void>();
  #frames: readonly Frame[] = [{ key: 0, shown: true }];
  #keys = 0;
  #latest: number;
  #current: Promise<Uint8Array | undefined>;
  #swap: ReturnType<typeof setTimeout> | undefined;

  constructor(version: number, read: ReadVersion, swapAfterMs = SWAP_AFTER_MS, readTimeoutMs = READ_TIMEOUT_MS) {
    this.#read = read;
    this.#swapAfterMs = swapAfterMs;
    this.#readTimeoutMs = readTimeoutMs;
    this.#latest = version;
    this.#current = this.#safeRead();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  frames = (): readonly Frame[] => this.#frames;

  show(version: number) {
    if (version === this.#latest) return;
    this.#latest = version;
    const before = this.#current;
    const next = this.#safeRead();
    void Promise.all([before, next]).then(([was, now]) => {
      if (this.#latest !== version || sameBytes(was, now)) return;
      this.#current = next;
      const key = ++this.#keys;
      this.#set([...this.#frames.filter((f) => f.shown), { key, shown: false }]);
      clearTimeout(this.#swap);
      this.#swap = setTimeout(() => this.loaded(key), this.#swapAfterMs);
    });
  }

  loaded(key: number) {
    if (!this.#frames.some((f) => f.key === key && !f.shown)) return;
    clearTimeout(this.#swap);
    this.#set([{ key, shown: true }]);
  }

  dispose() {
    clearTimeout(this.#swap);
    this.#latest = Number.NaN;
  }

  #safeRead(): Promise<Uint8Array | undefined> {
    const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, this.#readTimeoutMs));
    return Promise.race([this.#read().catch(() => undefined), timeout]);
  }

  #set(frames: readonly Frame[]) {
    this.#frames = frames;
    for (const listener of this.#listeners) listener();
  }
}

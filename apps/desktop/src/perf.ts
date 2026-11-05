/**
 * Always-on, near-free performance counters, so the UX bar is measured instead of argued about.
 * Read by the HUD (Ctrl+Shift+P) and by `pnpm bench` through `window.__topPerf`.
 */

const WINDOW_MS = 5_000;

type Sample = { at: number; value: number };

class Series {
  #samples: Sample[] = [];
  #all: number[] = [];
  push(value: number) {
    const at = performance.now();
    this.#samples.push({ at, value });
    this.#all.push(value);
    if (this.#all.length > 100_000) this.#all.splice(0, 50_000);
    while (this.#samples.length && this.#samples[0]!.at < at - WINDOW_MS) this.#samples.shift();
  }
  recent(): number[] {
    return this.#samples.map((s) => s.value);
  }
  all(): number[] {
    return this.#all;
  }
  reset() {
    this.#samples = [];
    this.#all = [];
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export const perf = {
  frames: new Series(),
  input: new Series(),
  longTasks: new Series(),
  renders: 0,
  firstContentAt: 0 as number,
  startedAt: Date.now() - performance.now(),

  markFirstContent() {
    if (!this.firstContentAt) this.firstContentAt = Date.now();
  },

  /** Time from a key event to the frame that shows it. */
  trackInput(event: { timeStamp: number }) {
    const start = event.timeStamp;
    requestAnimationFrame(() => {
      // rAF runs before paint; the message lands right after the frame is produced.
      const channel = new MessageChannel();
      channel.port1.onmessage = () => this.input.push(performance.now() - start);
      channel.port2.postMessage(null);
    });
  },

  reset() {
    this.frames.reset();
    this.input.reset();
    this.longTasks.reset();
  },

  report() {
    const frames = this.frames.all();
    const input = this.input.all();
    const over = (limit: number) => frames.filter((f) => f > limit).length;
    return {
      coldStartMs: this.firstContentAt ? this.firstContentAt - this.startedAt : undefined,
      frames: frames.length,
      frameP50: percentile(frames, 50),
      frameP99: percentile(frames, 99),
      framesOver20ms: over(20),
      framesOver33ms: over(33),
      fps: frames.length ? 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length) : 0,
      inputSamples: input.length,
      inputP50: percentile(input, 50),
      inputP99: percentile(input, 99),
      inputMax: input.length ? Math.max(...input) : 0,
      /** Keystrokes that did not make the next 60 Hz frame (16.7 ms of vsync wait + 4 ms slack). */
      inputMissedFrame: input.filter((v) => v > 20.7).length,
      longTasks: this.longTasks.all().length,
      longTaskMax: this.longTasks.all().length ? Math.max(...this.longTasks.all()) : 0,
    };
  },
};

// The frame loop costs a wakeup per vsync, so it only runs while someone is looking (HUD or bench).
let last = 0;
let running = false;
function tick(now: number) {
  if (!running) return;
  if (last) perf.frames.push(now - last);
  last = now;
  requestAnimationFrame(tick);
}
export function setFrameSampling(on: boolean) {
  if (on === running) return;
  running = on;
  last = 0;
  if (on) requestAnimationFrame(tick);
}
if (new URLSearchParams(location.search).has("bench")) setFrameSampling(true);

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
} catch {
  // not supported outside Chromium
}

(window as unknown as { __topPerf: typeof perf }).__topPerf = perf;

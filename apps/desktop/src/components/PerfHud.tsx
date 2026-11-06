import { useEffect, useState } from "react";
import { cn } from "../lib/utils.ts";
import { percentile, perf, setFrameSampling } from "../perf.ts";
import { top } from "../top.ts";

function Value({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return <b className={cn("font-semibold", ok === undefined ? "text-foreground" : ok ? "text-success" : "text-destructive")}>{children}</b>;
}

export function PerfHud() {
  const [, tick] = useState(0);
  useEffect(() => {
    setFrameSampling(true);
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => {
      clearInterval(timer);
      if (!new URLSearchParams(location.search).has("bench")) setFrameSampling(false);
    };
  }, []);
  const frames = perf.frames.recent();
  const input = perf.input.recent();
  const fps = frames.length ? 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length) : 0;
  const p99 = percentile(frames, 99);
  const inputP99 = percentile(input, 99);
  const longTasks = perf.longTasks.recent().length;
  const { rttMs, connection } = top.getSnapshot();
  return (
    <div className="pointer-events-none fixed top-18 right-4 z-10 min-w-47.5 rounded-xl bg-popover/90 px-3.5 py-2.5 font-mono text-micro leading-relaxed text-secondary-foreground shadow-popover backdrop-blur-md">
      <div>
        <Value ok={fps >= 55}>{fps.toFixed(0)}</Value> fps
      </div>
      <div>
        frame p99 <Value ok={p99 <= 20}>{p99.toFixed(1)}</Value> ms
      </div>
      <div>
        input p99 <Value ok={inputP99 <= 16}>{input.length ? inputP99.toFixed(1) : "–"}</Value> ms
      </div>
      <div>
        long tasks <Value ok={!longTasks}>{longTasks}</Value>
      </div>
      <div>
        rtt <Value>{rttMs ?? "–"}</Value> ms · {connection}
      </div>
    </div>
  );
}

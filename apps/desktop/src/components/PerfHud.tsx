import { useEffect, useState } from "react";
import { perf, percentile, setFrameSampling } from "../perf.ts";
import { top } from "../top.ts";

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
  const { rttMs, connection } = top.getSnapshot();
  return (
    <div className="hud">
      <div><b className={fps >= 55 ? "ok" : "bad"}>{fps.toFixed(0)}</b> fps</div>
      <div>frame p99 <b className={p99 <= 20 ? "ok" : "bad"}>{p99.toFixed(1)}</b> ms</div>
      <div>input p99 <b className={inputP99 <= 16 ? "ok" : "bad"}>{input.length ? inputP99.toFixed(1) : "–"}</b> ms</div>
      <div>long tasks <b className={perf.longTasks.recent().length ? "bad" : "ok"}>{perf.longTasks.recent().length}</b></div>
      <div>rtt <b>{rttMs ?? "–"}</b> ms · {connection}</div>
    </div>
  );
}

// Runs inside Electron when TOP_BENCH is set: drives the real window with real input events and
// prints one JSON result line. Orchestrated by scripts/bench.js, which also kills/restarts the daemon.
import { app } from "electron";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (tag, value) => process.stdout.write(`BENCH:${tag} ${JSON.stringify(value ?? null)}\n`);

/** Wait for a line on stdin from the orchestrator. */
const stdinLines = [];
let stdinWaiter;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n").filter(Boolean)) {
    stdinLines.push(line.trim());
    stdinWaiter?.();
  }
});
async function waitFor(line) {
  for (;;) {
    const i = stdinLines.indexOf(line);
    if (i >= 0) return void stdinLines.splice(i, 1);
    await new Promise((r) => (stdinWaiter = r));
  }
}

export async function runBench(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const until = async (code, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return true;
      await sleep(50);
    }
    const state = await js("JSON.stringify({ connection: window.__top?.getSnapshot().connection, bots: window.__top?.getSnapshot().bots.length, page: document.body.innerText.slice(0, 300) })").catch((e) => String(e));
    throw new Error(`timed out waiting for: ${code}\n  state: ${state}`);
  };

  await new Promise((r) => wc.once("did-finish-load", r));
  await until("window.__topPerf && window.__topPerf.firstContentAt > 0");
  const t0 = Number(process.env.TOP_BENCH_T0);
  const firstContentAt = await js("window.__topPerf.firstContentAt");
  const result = { coldStartMs: firstContentAt - t0 };

  if (process.env.TOP_BENCH === "screenshot") {
    // Wait for every bot to be live and a couple of them working, then capture the window.
    await until("window.__top.getSnapshot().bots.length >= 5 && window.__top.getSnapshot().connection === 'open'");
    await js(`window.__topSelect(${Number(process.env.TOP_SHOT_BOT ?? 1)})`);
    const shotSelector = JSON.stringify(process.env.TOP_SHOT_WAIT ?? "");
    await until(`window.__top.getSnapshot().bots.filter(b => b.status !== 'idle').length >= ${Number(process.env.TOP_SHOT_BUSY ?? 2)} && document.querySelectorAll('.transcript .row').length >= ${Number(process.env.TOP_SHOT_ROWS ?? 4)} && (!${shotSelector} || !!document.querySelector(${shotSelector}))`, 60_000);
    await sleep(Number(process.env.TOP_SHOT_DELAY ?? 1200));
    const image = await wc.capturePage();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.TOP_SHOT_PATH, image.toPNG());
    out("RESULT", { ...result, screenshot: process.env.TOP_SHOT_PATH });
    app.quit();
    return;
  }

  if (process.env.TOP_BENCH === "coldstart") {
    out("RESULT", result);
    app.quit();
    return;
  }

  await until("window.__top.getSnapshot().bots.length >= 5 && window.__top.getSnapshot().connection === 'open'");
  await sleep(1500); // let the load driver get every bot streaming

  // ── 1. typing while 5 bots stream ─────────────────────────────────────────
  await js("window.__topSelect(1)");
  await sleep(500);
  await js("document.querySelector('.composer textarea').focus()");
  await js("window.__topPerf.reset()");
  const streaming = await js("window.__top.getSnapshot().bots.filter(b => b.status !== 'idle').length");
  const typeEnd = Date.now() + 8_000;
  let typed = 0;
  while (Date.now() < typeEnd) {
    const ch = "abcdefghij klmnop "[typed++ % 18];
    wc.sendInputEvent({ type: "keyDown", keyCode: ch === " " ? "Space" : ch });
    wc.sendInputEvent({ type: "char", keyCode: ch });
    wc.sendInputEvent({ type: "keyUp", keyCode: ch === " " ? "Space" : ch });
    await sleep(55);
  }
  await sleep(200);
  result.typing = { ...(await js("window.__topPerf.report()")), botsBusyAtStart: streaming, keys: typed };
  await js(`(() => { const t = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  // ── 2. scrolling a 10,000-message transcript ──────────────────────────────
  await js("window.__topSelect(0)");
  await until("document.querySelectorAll('.transcript .row').length > 5");
  await sleep(500);
  await js("window.__topPerf.reset()");
  result.scroll = await js(`new Promise((resolve) => {
    const el = document.querySelector('.transcript');
    const start = performance.now();
    let direction = -1, distance = 0;
    function step(now) {
      if (now - start > 8000) {
        resolve({ ...window.__topPerf.report(), scrolledPx: distance, rowsInDom: document.querySelectorAll('.transcript .row').length,
          itemsLoaded: window.__top.conversation(window.__top.getSnapshot().bots[0].id).getSnapshot().items.length });
        return;
      }
      const before = el.scrollTop;
      el.scrollTop += direction * 90;
      distance += Math.abs(el.scrollTop - before);
      if (now - start > 6000) direction = 1; // and fling back down for the last 2 s
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  })`);

  // ── 3. daemon killed with kill -9 mid-turn, message sent while it's down ───
  await js("window.__topSelect(2)");
  await sleep(300);
  out("KILL");
  await until("window.__top.getSnapshot().connection !== 'open'", 15_000);
  const lostAt = Date.now();
  await js("window.__benchMsg = window.__top.conversation(window.__top.getSnapshot().bots[2].id).send('sent while the daemon was down').requestId");
  const pendingWhileDown = await js(`window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot().pending.length`);
  const shownStale = await js("!!document.querySelector('.stale')");
  const rowsWhileDown = await js("document.querySelectorAll('.transcript .row').length");
  out("RESTART");
  await waitFor("RESTARTED");
  const restartedAt = Date.now();
  await until("window.__top.getSnapshot().connection === 'open'", 20_000);
  const reconnectedAt = Date.now();
  // Durably accepted: the daemon has it (queued in the inbox or placed), the pending copy is gone.
  await until("window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot().pending.length === 0", 20_000);
  const acceptedAt = Date.now();
  await until(`(() => { const s = window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot();
    return s.status === 'live' && s.pending.length === 0 && s.items.some(i => i.kind === 'entry' && i.entry.requestId === window.__benchMsg); })()`, 20_000);
  const deliveredAt = Date.now();
  const duplicates = await js(`(() => { const s = window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot();
    return s.items.filter(i => i.kind === 'entry' && i.entry.requestId === window.__benchMsg).length; })()`);
  result.reconnect = {
    downMs: restartedAt - lostAt,
    reconnectAfterRestartMs: reconnectedAt - restartedAt,
    offlineMessageAcceptedAfterRestartMs: acceptedAt - restartedAt,
    offlineMessagePlacedAfterRestartMs: deliveredAt - restartedAt,
    pendingWhileDown,
    staleBannerShown: shownStale,
    rowsKeptWhileDown: rowsWhileDown,
    copiesOfOfflineMessage: duplicates,
  };

  out("RESULT", result);
  app.quit();
}

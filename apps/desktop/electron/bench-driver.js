import { app } from "electron";

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * @param {string} tag
 * @param {unknown} [value]
 */
const out = (tag, value) => process.stdout.write(`BENCH:${tag} ${JSON.stringify(value ?? null)}\n`);

/** @type {string[]} */
const stdinLines = [];
/** @type {(() => void) | undefined} */
let stdinWaiter;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\n").filter(Boolean)) {
    stdinLines.push(line.trim());
    stdinWaiter?.();
  }
});
/** @param {string} line */
async function waitFor(line) {
  for (;;) {
    const i = stdinLines.indexOf(line);
    if (i >= 0) return void stdinLines.splice(i, 1);
    await new Promise((r) => {
      stdinWaiter = () => r(undefined);
    });
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
const within = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms))]);

const SETTLE = "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";

/** @param {import("electron").BrowserWindow} win */
export async function runBench(win) {
  const wc = win.webContents;
  /** @param {string} code */
  const js = (code) => wc.executeJavaScript(code, true);
  /**
   * @param {string} code
   * @param {number} [timeoutMs]
   */
  const until = async (code, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await js(code).catch(() => false)) return true;
      await sleep(50);
    }
    const state = await js(
      "JSON.stringify({ connection: window.__top?.getSnapshot().connection, bots: window.__top?.getSnapshot().bots.length, page: document.body.innerText.slice(0, 300) })",
    ).catch((/** @type {unknown} */ e) => String(e));
    throw new Error(`timed out waiting for: ${code}\n  state: ${state}`);
  };

  if (process.env.TOP_BENCH === "screenshot")
    wc.on("console-message", (event) => {
      if (event.level === "error" || process.env.TOP_SHOT_CONSOLE) process.stdout.write(`[page ${event.level}] ${event.message}\n`);
    });
  await new Promise((r) => wc.once("did-finish-load", () => r(undefined)));
  await until("window.__topPerf && window.__topPerf.firstContentAt > 0");
  const t0 = Number(process.env.TOP_BENCH_T0);
  const firstContentAt = await js("window.__topPerf.firstContentAt");
  /** @type {Record<string, unknown>} */
  const result = { coldStartMs: firstContentAt - t0 };

  if (process.env.TOP_BENCH === "screenshot") {
    await until(`window.__top.getSnapshot().bots.length >= ${Number(process.env.TOP_SHOT_BOTS ?? 5)} && window.__top.getSnapshot().connection === 'open'`);
    await js(`window.__topSelect(${Number(process.env.TOP_SHOT_BOT ?? 1)})`);
    const shotSelector = JSON.stringify(process.env.TOP_SHOT_WAIT ?? "");
    await until(
      `window.__top.getSnapshot().bots.filter(b => b.status !== 'idle').length >= ${Number(process.env.TOP_SHOT_BUSY ?? 2)} && document.querySelectorAll('.transcript .row').length >= ${Number(process.env.TOP_SHOT_ROWS ?? 4)} && (!${shotSelector} || !!document.querySelector(${shotSelector}))`,
      60_000,
    );
    if (process.env.TOP_SHOT_SCROLL && process.env.TOP_SHOT_WAIT) await js(`document.querySelector(${shotSelector})?.scrollIntoView({ block: "center" })`);
    if (process.env.TOP_SHOT_HOVER) {
      const rect = await js(
        `(() => { const all = document.querySelectorAll(${JSON.stringify(process.env.TOP_SHOT_HOVER)}); const r = all[all.length - 1]?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) }; })()`,
      );
      if (rect) wc.sendInputEvent({ type: "mouseMove", x: Math.round(rect.x), y: Math.round(rect.y) });
    }
    if (process.env.TOP_SHOT_JS) await within(js(process.env.TOP_SHOT_JS), 20_000, "TOP_SHOT_JS");
    await sleep(Number(process.env.TOP_SHOT_DELAY ?? 1200));
    await within(js(SETTLE), 5_000, "Waiting for the page to settle");
    wc.debugger.attach("1.3");
    const { data } = await within(wc.debugger.sendCommand("Page.captureScreenshot", { format: "png" }), 10_000, "Capturing the window");
    const image = Buffer.from(data, "base64");
    const { writeFileSync } = await import("node:fs");
    const path = process.env.TOP_SHOT_PATH;
    if (!path) throw new Error("TOP_SHOT_PATH is not set");
    writeFileSync(path, image);
    out("RESULT", { ...result, screenshot: path });
    app.quit();
    return;
  }

  if (process.env.TOP_BENCH === "coldstart") {
    out("RESULT", result);
    app.quit();
    return;
  }

  await until(`window.__top.getSnapshot().bots.length >= ${Number(process.env.TOP_SHOT_BOTS ?? 5)} && window.__top.getSnapshot().connection === 'open'`);
  await sleep(1500);

  await js("window.__topSelect(1)");
  await sleep(500);
  await js("document.querySelector('.composer-input').focus()");
  await js("window.__topPerf.reset()");
  const streaming = await js("window.__top.getSnapshot().bots.filter(b => b.status !== 'idle').length");
  const typeEnd = Date.now() + 8_000;
  let typed = 0;
  while (Date.now() < typeEnd) {
    const ch = "abcdefghij klmnop ".charAt(typed++ % 18);
    wc.sendInputEvent({ type: "keyDown", keyCode: ch === " " ? "Space" : ch });
    wc.sendInputEvent({ type: "char", keyCode: ch });
    wc.sendInputEvent({ type: "keyUp", keyCode: ch === " " ? "Space" : ch });
    await sleep(55);
  }
  await sleep(200);
  result.typing = { ...(await js("window.__topPerf.report()")), botsBusyAtStart: streaming, keys: typed };
  await js(`(() => { const t = document.querySelector('.composer-input'); t.replaceChildren(); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);

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
      if (now - start > 6000) direction = 1;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  })`);

  await js("window.__topSelect(2)");
  await sleep(300);
  out("KILL");
  await until("window.__top.getSnapshot().connection !== 'open'", 15_000);
  const lostAt = Date.now();
  await js("window.__benchMsg = window.__top.conversation(window.__top.getSnapshot().bots[2].id).send('sent while the daemon was down').requestId");
  const pendingWhileDown = await js(`window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot().pending.length`);
  const shownStale = await js("window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot().status === 'stale'");
  const rowsWhileDown = await js("document.querySelectorAll('.transcript .row').length");
  out("RESTART");
  await waitFor("RESTARTED");
  const restartedAt = Date.now();
  await until("window.__top.getSnapshot().connection === 'open'", 20_000);
  const reconnectedAt = Date.now();
  await until("window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot().pending.length === 0", 20_000);
  const acceptedAt = Date.now();
  await until(
    `(() => { const s = window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot();
    return s.status === 'live' && s.pending.length === 0 && s.items.some(i => i.kind === 'entry' && i.entry.requestId === window.__benchMsg); })()`,
    20_000,
  );
  const deliveredAt = Date.now();
  const duplicates = await js(`(() => { const s = window.__top.conversation(window.__top.getSnapshot().bots[2].id).getSnapshot();
    return s.items.filter(i => i.kind === 'entry' && i.entry.requestId === window.__benchMsg).length; })()`);
  result.reconnect = {
    downMs: restartedAt - lostAt,
    reconnectAfterRestartMs: reconnectedAt - restartedAt,
    offlineMessageAcceptedAfterRestartMs: acceptedAt - restartedAt,
    offlineMessagePlacedAfterRestartMs: deliveredAt - restartedAt,
    pendingWhileDown,
    staleShown: shownStale,
    rowsKeptWhileDown: rowsWhileDown,
    copiesOfOfflineMessage: duplicates,
  };

  out("RESULT", result);
  app.quit();
}

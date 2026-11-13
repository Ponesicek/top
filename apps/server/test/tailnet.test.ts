import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ServerFrame } from "@top/protocol";
import { WebSocket } from "ws";
import { Daemon } from "../src/daemon.ts";
import { createFakeModelProvider, FAKE_MODEL, FAKE_PROVIDER } from "../src/fake-bots.ts";
import { CALLBACK_PATH } from "../src/mcp.ts";
import { serve } from "../src/serve.ts";
import { Store } from "../src/store.ts";
import { type Caller, parseAllow, parseStatus, parseWhois, Tailnet, type TailnetSelf } from "../src/tailscale.ts";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

// ── what the CLI says ────────────────────────────────────────────────────────────

const status = (self: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    Self: { ID: "nSELF", HostName: "Box", DNSName: "box.tail1234.ts.net.", UserID: 1, ...self },
    User: {
      1: { LoginName: "you@example.com" },
      2: { LoginName: "tagged-devices" },
      3: { LoginName: "friend@example.com" },
      4: { LoginName: "box.tail1234.ts.net" },
    },
    CertDomains: ["box.tail1234.ts.net"],
    CurrentTailnet: { MagicDNSEnabled: true },
    ...extra,
  });

test("a device a person owns is theirs; a tagged one has no owner", () => {
  const owned = parseStatus(status({}));
  assert.equal(owned.dnsName, "box.tail1234.ts.net");
  assert.equal(owned.device, "box");
  assert.equal(owned.owner, "you@example.com");
  assert.equal(owned.https, true);

  const tagged = parseStatus(status({ UserID: 4, Tags: ["tag:servers"] }));
  assert.equal(tagged.owner, undefined);
  assert.deepEqual(tagged.tags, ["tag:servers"]);

  assert.equal(parseStatus(status({}, { CertDomains: null })).https, false);
  assert.throws(() => parseStatus(status({}, { BackendState: "NeedsLogin" })), /tailscale up/);
  assert.throws(() => parseStatus(status({}, { BackendState: "Stopped" })), /Stopped/);
  assert.throws(() => parseStatus(status({}, { CurrentTailnet: { MagicDNSEnabled: false } })), /MagicDNS/);
});

test("whois names the device, and its owner only when it isn't tagged", () => {
  const person = parseWhois(
    JSON.stringify({
      Node: { StableID: "nPHONE", Name: "phone.tail1234.ts.net.", ComputedName: "Phone" },
      UserProfile: { LoginName: "you@example.com", DisplayName: "You" },
    }),
  );
  assert.deepEqual(person, { stableId: "nPHONE", device: "phone", dnsName: "phone.tail1234.ts.net", tags: [], login: "you@example.com", name: "You" });
  const tagged = parseWhois(
    JSON.stringify({
      Node: { StableID: "nLAP", Name: "laptop.tail1234.ts.net.", ComputedName: "laptop", Tags: ["tag:laptops"] },
      UserProfile: { LoginName: "tagged-devices", DisplayName: "Tagged Devices" },
    }),
  );
  assert.equal(tagged?.login, undefined);
  assert.deepEqual(tagged?.tags, ["tag:laptops"]);
});

test("without --tailscale-allow the whole tailnet may connect; with it, the owner and those named", () => {
  const tagged = new Tailnet({ self: parseStatus(status({ UserID: 4, Tags: ["tag:servers"] })), allow: [], cli: async () => "" });
  assert.deepEqual(tagged.rules, []);
  assert.equal(tagged.describeAllowed(), "every device on it");
  assert.deepEqual(new Tailnet({ self: parseStatus(status({})), allow: [], cli: async () => "" }).rules, [], "not even the owner is singled out");
  const owned = new Tailnet({ self: parseStatus(status({})), allow: parseAllow(["You@Example.com, tag:laptops", "Phone"]), cli: async () => "" });
  assert.deepEqual(owned.rules, [
    { kind: "login", value: "you@example.com" },
    { kind: "tag", value: "tag:laptops" },
    { kind: "device", value: "phone" },
  ]);
  assert.equal(owned.describeAllowed(), "you@example.com, tag:laptops, phone (and this computer)");
  assert.equal(owned.url, "wss://box.tail1234.ts.net:7357");
  assert.equal(new Tailnet({ self: owned.self, allow: [], port: 443, cli: async () => "" }).url, "wss://box.tail1234.ts.net");
});

// ── setting up Serve ─────────────────────────────────────────────────────────────

function fakeCli(serveStatus: object, fail?: string) {
  const calls: string[][] = [];
  const cli = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "serve" && args[1] === "status") return JSON.stringify(serveStatus);
    if (fail && args[0] === "serve") throw new Error(fail);
    return "";
  };
  return { cli, calls };
}

test("Serve is pointed at the tailnet listener, and never takes over someone else's port", async () => {
  const self = parseStatus(status({}));
  const host = "box.tail1234.ts.net:7357";

  const fresh = fakeCli({ TCP: { 443: { HTTPS: true } }, Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
  const tailnet = new Tailnet({ self, allow: [], cli: fresh.cli });
  await tailnet.expose(7359);
  assert.deepEqual(fresh.calls.at(-1), ["serve", "--bg", "--https=7357", "http://127.0.0.1:7359"]);
  await tailnet.unexpose();
  assert.deepEqual(fresh.calls.at(-1), ["serve", "--https=7357", "off"]);

  // Already ours (left by a run that crashed): set it again.
  const ours = fakeCli({ TCP: { 7357: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7359" } } } } });
  await new Tailnet({ self, allow: [], cli: ours.cli }).expose(7359);
  assert.equal(ours.calls.at(-1)?.[1], "--bg");

  const taken = fakeCli({ TCP: { 7357: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } });
  await assert.rejects(new Tailnet({ self, allow: [], cli: taken.cli }).expose(7359), /already serves something else \(\/ → http:\/\/127\.0\.0\.1:8080\)/);
  assert.ok(!taken.calls.some((c) => c[1] === "--bg"));

  const funnel = fakeCli({
    TCP: { 7357: { HTTPS: true } },
    Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7359" } } } },
    AllowFunnel: { [host]: true },
  });
  await assert.rejects(new Tailnet({ self, allow: [], cli: funnel.cli }).expose(7359), /Funnel is on/);

  const noHttps = { ...self, https: false };
  await assert.rejects(new Tailnet({ self: noHttps, allow: [], cli: fresh.cli }).expose(7359), /HTTPS certificates/);

  const denied = fakeCli({}, "Access denied: serve config denied");
  await assert.rejects(new Tailnet({ self, allow: [], cli: denied.cli }).expose(7359), /tailscale set --operator=\$USER/);
});

// ── the tailnet listener ─────────────────────────────────────────────────────────

const callers: Record<string, Caller> = {
  "100.64.0.1": { stableId: "nPHONE", device: "phone", dnsName: "phone.tail1234.ts.net", tags: [], login: "you@example.com", name: "You" },
  "100.64.0.2": { stableId: "nLAP", device: "laptop", dnsName: "laptop.tail1234.ts.net", tags: ["tag:laptops"], login: undefined, name: undefined },
  "100.64.0.3": { stableId: "nFRIEND", device: "friends-pc", dnsName: "friends-pc.tail1234.ts.net", tags: [], login: "friend@example.com", name: "Friend" },
  "100.64.0.4": { stableId: "nCI", device: "ci", dnsName: "ci.tail1234.ts.net", tags: ["tag:ci"], login: undefined, name: undefined },
  "100.64.0.9": { stableId: "nSELF", device: "box", dnsName: "box.tail1234.ts.net", tags: [], login: "you@example.com", name: "You" },
};

async function setup(allow: readonly string[] = ["tag:laptops"]) {
  const dir = mkdtempSync(join(tmpdir(), "top-tailnet-"));
  const store = new Store(join(dir, "top.sqlite"));
  store.createBot("Atlas", "", `${FAKE_PROVIDER}/${FAKE_MODEL}`);
  const models = createModels();
  models.setProvider(createFakeModelProvider(1_000).provider);
  const daemon = new Daemon(store, models, [], { files: (bot) => join(dir, "bots", bot.name, "files") });
  const bot = store.bots()[0]!.id;
  const folder = daemon.files(bot)!.folder;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "report.html"), "<h1>Report</h1>");

  const lookups: string[] = [];
  const self: TailnetSelf = { ...parseStatus(status({})), stableId: "nSELF" };
  const gate = new Tailnet({
    self,
    allow: parseAllow(allow),
    cli: async () => "",
    whois: async (address) => {
      lookups.push(address);
      return callers[address];
    },
  });
  // Stands in for MCP's sign-in redirect server.
  const oauth = createServer((request, response) => response.end(`signed in: ${request.url}`));
  await new Promise<void>((resolve) => oauth.listen(0, "127.0.0.1", resolve));
  const oauthPort = (oauth.address() as { port: number }).port;

  const server = serve(daemon, { host: "127.0.0.1", port: 0, compress: false, tailnet: { gate, port: 0, oauthPort, oauthPath: CALLBACK_PATH } });
  const port = await server.listening;
  const tsPort = (await server.tailnetListening)!;
  cleanup.push(async () => {
    await server.close();
    await new Promise((resolve) => oauth.close(resolve));
    daemon.closeFiles();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, bot, port, tsPort, lookups, oauth };
}

/** Open the WebSocket and answer with its `welcome`, or the HTTP status it was refused with. */
function welcome(url: string, headers: Record<string, string> = {}, origin?: string) {
  return new Promise<Extract<ServerFrame, { t: "welcome" }> | number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers, ...(origin ? { origin } : {}) });
    socket.on("message", (data) => {
      socket.close();
      resolve(JSON.parse(String(data)));
    });
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on("error", (error) => !String(error).includes("Unexpected server response") && reject(error));
  });
}

const from = (address: string) => ({ "X-Forwarded-For": address });

test("the tailnet port lets in only the people and devices allowed, and tells each who it is", async () => {
  const { port, tsPort, lookups } = await setup();
  const ts = `ws://127.0.0.1:${tsPort}`;

  const owner = await welcome(ts, from("100.64.0.1"));
  assert.ok(typeof owner === "object");
  assert.deepEqual(owner.viewer, { device: "phone", login: "you@example.com", name: "You" });
  assert.equal(owner.tailnetUrl, "wss://box.tail1234.ts.net:7357");

  const tagged = await welcome(ts, from("100.64.0.2"));
  assert.ok(typeof tagged === "object");
  assert.deepEqual(tagged.viewer, { device: "laptop", tags: ["tag:laptops"] });

  // This computer itself, through its own tailnet name.
  assert.equal(typeof (await welcome(ts, from("100.64.0.9"))), "object");

  assert.equal(await welcome(ts, from("100.64.0.3")), 403, "another person on the tailnet");
  assert.equal(await welcome(ts, from("100.64.0.4")), 403, "a tagged device without an allowed tag");
  assert.equal(await welcome(ts, from("203.0.113.7")), 403, "not on the tailnet (Funnel)");
  assert.equal(await welcome(ts), 403, "not through Serve");
  // A web page on an allowed device still can't open it.
  assert.equal(await welcome(ts, from("100.64.0.1"), "https://evil.example"), 403);
  assert.equal(typeof (await welcome(ts, from("100.64.0.1"), "file://")), "object");

  // Lookups are reused for a while.
  assert.equal(lookups.filter((a) => a === "100.64.0.1").length, 1);

  // The local port is unchanged: no identity needed, and it says where the daemon is on the tailnet.
  const local = await welcome(`ws://127.0.0.1:${port}`);
  assert.ok(typeof local === "object");
  assert.equal(local.viewer, undefined);
  assert.equal(local.tailnetUrl, "wss://box.tail1234.ts.net:7357");
});

test("without --tailscale-allow every tailnet device gets in, and nothing else does", async () => {
  const { tsPort } = await setup([]);
  const ts = `ws://127.0.0.1:${tsPort}`;
  const friend = await welcome(ts, from("100.64.0.3"));
  assert.ok(typeof friend === "object");
  assert.deepEqual(friend.viewer, { device: "friends-pc", login: "friend@example.com", name: "Friend" });
  assert.equal(typeof (await welcome(ts, from("100.64.0.4"))), "object", "a tagged device");
  assert.equal(await welcome(ts, from("203.0.113.7")), 403, "not on the tailnet (Funnel)");
  assert.equal(await welcome(ts), 403, "not through Serve");
  assert.equal(await welcome(ts, from("100.64.0.3"), "https://evil.example"), 403, "a web page");
});

test("files, discovery and sign-in redirects on the tailnet are for allowed callers only", async () => {
  const { store, bot, tsPort, oauth } = await setup();
  const base = `http://127.0.0.1:${tsPort}`;
  const file = `${base}/files/${store.filesSecret}/${bot}/report.html`;

  assert.equal(await (await fetch(file, { headers: from("100.64.0.1") })).text(), "<h1>Report</h1>");
  const refused = await fetch(file, { headers: from("100.64.0.3") });
  assert.equal(refused.status, 403, "the secret alone isn't enough on the tailnet");
  assert.match(await refused.text(), /friends-pc \(friend@example\.com\) isn't allowed.*--tailscale-allow friend@example\.com/);

  const found = await fetch(`${base}/.well-known/top`, { headers: from("100.64.0.2") });
  assert.equal(found.status, 200);
  const body = (await found.json()) as Record<string, unknown>;
  assert.equal(body.top, true);
  assert.equal(body.serverId, store.id);
  assert.equal(body.device, "box");
  const hidden = await fetch(`${base}/.well-known/top`, { headers: from("100.64.0.4") });
  assert.equal(hidden.status, 403);
  assert.deepEqual(Object.keys((await hidden.json()) as object).sort(), ["device", "error", "top"]);

  const callback = `${base}${CALLBACK_PATH}?code=abc&state=xyz`;
  assert.equal(await (await fetch(callback, { headers: from("100.64.0.1") })).text(), `signed in: ${CALLBACK_PATH}?code=abc&state=xyz`);
  assert.equal((await fetch(callback, { headers: from("100.64.0.3") })).status, 403);
  await new Promise((resolve) => oauth.close(resolve));
  const nobody = await fetch(callback, { headers: from("100.64.0.1") });
  assert.equal(nobody.status, 404);
  assert.match(await nobody.text(), /No sign-in is waiting/);
});

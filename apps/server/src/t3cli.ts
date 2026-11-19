// `top t3code …`: connect Top to a T3 Code server over its own API, with a pairing code.
import {
  checkProtocol,
  checkSession,
  describe,
  exchangePairingCode,
  listProjects,
  plainHttpExposed,
  RpcSocket,
  readT3Config,
  removeT3Config,
  T3_SCOPES,
  type T3Config,
  t3Origin,
  writeT3Config,
} from "./tasks/t3api.ts";

const say = (line = "") => process.stdout.write(`${line}\n`);

/** Reads the code without echoing it, or from stdin when that isn't a terminal. */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += chunk;
    return text.trim();
  }
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let text = "";
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(text.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else text += char;
      }
    };
    input.on("data", onData);
  });
}

/** A pasted pairing link carries its code in the fragment (`/pair#token=…`); a bare code or token is taken as is. */
export function credentialOf(pasted: string): string {
  const text = pasted.trim();
  try {
    const url = new URL(text);
    const fromHash = new URLSearchParams(url.hash.slice(1)).get("token");
    const found = fromHash ?? url.searchParams.get("token");
    if (found) return found;
  } catch {}
  return text;
}

async function describeConnection(config: T3Config) {
  const socket = await RpcSocket.open(config.url, config.token, () => {});
  try {
    const value = (await socket.request("server.getConfig", {})) as {
      providers?: { instanceId?: string; enabled?: boolean; status?: string; models?: { slug?: string; isDefault?: boolean }[] }[];
    };
    const providers = (value.providers ?? []).filter((p) => p.enabled !== false);
    say(providers.length ? "Providers (the `provider` option) and their models (`model`):" : "No providers are switched on in T3 Code.");
    for (const p of providers) {
      const models = (p.models ?? []).map((m) => `${m.slug}${m.isDefault ? " (default)" : ""}`);
      say(`  ${p.instanceId} [${p.status}]: ${models.slice(0, 12).join(", ") || "no models listed"}${models.length > 12 ? ", …" : ""}`);
    }
  } finally {
    socket.close();
  }
  const projects = await listProjects(config.url, config.token);
  say(projects.length ? "Projects (a task's `cwd`):" : "No projects yet: add folders as projects in T3 Code, then a task's `cwd` names one.");
  for (const p of projects) say(`  ${p.workspaceRoot} (${p.title})`);
}

export async function t3Connect(file: string, address: string, plainHttp: boolean): Promise<void> {
  const origin = t3Origin(address);
  if (plainHttpExposed(origin) && !plainHttp)
    throw new Error(
      `${origin} is plain HTTP to another computer, so the pairing code and Top's credential travel unencrypted unless the network itself encrypts them (a tailnet does). Use its HTTPS address (for example Tailscale Serve's https://….ts.net), or pass --plain-http to accept that.`,
    );
  const descriptor = await describe(origin);
  checkProtocol(origin, descriptor);
  say(`T3 Code ${descriptor.serverVersion} on ${descriptor.label} answers at ${origin}.`);
  say(`Make a pairing code on that computer with: t3 auth pairing create --scope ${T3_SCOPES.join(" --scope ")} --label Top`);
  say("(or a pairing link from T3 Code's Settings → Sharing & access). Top keeps only its own session from it.");
  const pasted = credentialOf(await readSecret("Pairing code: "));
  if (!pasted) throw new Error("No code given; nothing changed.");
  // Always traded for Top's own session, narrowed to what Top needs, whatever the code itself grants.
  const token = await exchangePairingCode(origin, pasted, "Top");
  const session = await checkSession(origin, token);
  const config: T3Config = {
    url: origin,
    token,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    serverVersion: descriptor.serverVersion,
    connectedAt: new Date().toISOString(),
  };
  await writeT3Config(file, config);
  say(`Connected. Saved in ${file}${session.expiresAt ? `; T3 Code's session for Top lasts until ${session.expiresAt}` : ""}.`);
  await describeConnection(config).catch((error: unknown) =>
    say(`(Couldn't list providers and projects: ${error instanceof Error ? error.message : String(error)})`),
  );
  say("Restart Top's daemon to offer T3 Code to the bots (`systemctl --user restart top` for the installed one).");
}

export async function t3Status(file: string): Promise<void> {
  const config = await readT3Config(file);
  if (!config) {
    say("T3 Code isn't connected. Run `top t3code connect <address>`.");
    return;
  }
  say(`T3 Code at ${config.url} (${config.label}), paired ${config.connectedAt}.`);
  const descriptor = await describe(config.url);
  checkProtocol(config.url, descriptor);
  if (config.environmentId && descriptor.environmentId !== config.environmentId)
    throw new Error(`${config.url} now answers as a different T3 Code environment (${descriptor.label}); Top won't send it the credential.`);
  const session = await checkSession(config.url, config.token);
  say(`Reachable: T3 Code ${descriptor.serverVersion}; Top's session is valid${session.expiresAt ? ` until ${session.expiresAt}` : ""}.`);
  await describeConnection(config);
}

export async function t3Disconnect(file: string): Promise<void> {
  const config = await readT3Config(file).catch(() => undefined);
  await removeT3Config(file);
  say("Top forgot its T3 Code connection.");
  if (config)
    say(
      `Its session still exists on ${config.label} until it expires: revoke it there in Settings → Sharing & access, or with \`t3 auth session list\` and \`t3 auth session revoke <id>\`.`,
    );
}

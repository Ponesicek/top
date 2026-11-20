// `top t3code …`: connect Top to a T3 Code server over its own API, with a pairing code.
import { checkSession, overview, pair, preflight, readT3Config, removeT3Config, T3_SCOPES, type T3Config, verifyEnvironment } from "./tasks/t3api.ts";

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

async function describeConnection(config: T3Config) {
  const { providers, projects } = await overview(config);
  say(providers.length ? "Providers (the `provider` option) and their models (`model`):" : "No providers are switched on in T3 Code.");
  for (const p of providers) {
    const models = p.models.map((m) => `${m.slug}${m.isDefault ? " (default)" : ""}`);
    say(`  ${p.id} [${p.status}]: ${models.slice(0, 12).join(", ") || "no models listed"}${models.length > 12 ? ", …" : ""}`);
  }
  say(projects.length ? "Projects (a task's `cwd`):" : "No projects yet: add folders as projects in T3 Code, then a task's `cwd` names one.");
  for (const p of projects) say(`  ${p.workspaceRoot} (${p.title})`);
}

export async function t3Connect(file: string, address: string, plainHttp: boolean): Promise<void> {
  const { origin, descriptor } = await preflight(address, plainHttp, "pass --plain-http");
  say(`T3 Code ${descriptor.serverVersion} on ${descriptor.label} answers at ${origin}.`);
  say(`Make a pairing code on that computer with: t3 auth pairing create --scope ${T3_SCOPES.join(" --scope ")} --label Top`);
  say("(or a pairing link from T3 Code's Settings → Sharing & access). Top keeps only its own session from it.");
  const { config, expiresAt } = await pair(file, origin, descriptor, await readSecret("Pairing code: "));
  say(`Connected. Saved in ${file}${expiresAt ? `; T3 Code's session for Top lasts until ${expiresAt}` : ""}.`);
  await describeConnection(config).catch((error: unknown) =>
    say(`(Couldn't list providers and projects: ${error instanceof Error ? error.message : String(error)})`),
  );
  say("Bots can hand T3 Code tasks from their next message; the daemon doesn't need a restart.");
}

export async function t3Status(file: string): Promise<void> {
  const config = await readT3Config(file);
  if (!config) {
    say("T3 Code isn't connected. Connect it in Top's Settings → T3 Code, or run `top t3code connect <address>`.");
    return;
  }
  say(`T3 Code at ${config.url} (${config.label}), paired ${config.connectedAt}.`);
  const descriptor = await verifyEnvironment(config);
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

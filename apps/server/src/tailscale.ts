/**
 * Top on your tailnet, through the Tailscale already running on this computer.
 *
 * `--tailscale` puts the daemon at `wss://<device>.<tailnet>.ts.net:7357` with Tailscale Serve: a real
 * HTTPS certificate, nothing opened on the network by Top itself. Serve forwards to a second listener
 * on 127.0.0.1 (the tailnet port) that lets in every device on the tailnet, or with
 * `--tailscale-allow` only the people and devices named: each request's `X-Forwarded-For`, which
 * Serve always overwrites with the caller's tailnet address, is looked up with `tailscale whois`.
 * That names tagged devices too (Serve's `Tailscale-User-*` headers are only set for devices a
 * person owns).
 *
 * Why a separate listener: on the local port, a request Serve forwarded would look like one from this
 * computer, which is let in without asking. Anything reaching the tailnet port without an identity
 * (Funnel's public traffic, an address whois doesn't know) is refused.
 *
 * Talks to tailscaled through its CLI, which hides where its socket is on each OS.
 */
import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Viewer } from "@top/protocol";

/** Runs the `tailscale` CLI and answers with its stdout. Rejects with its stderr (or why it couldn't start). */
export type TailscaleCli = (args: readonly string[]) => Promise<string>;

/** A problem the user can fix: printed as is, without a stack. */
export class TailscaleError extends Error {
  override name = "TailscaleError";
}

const CANDIDATES: Record<string, readonly string[]> = {
  darwin: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  win32: ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"],
};

/** The system's `tailscale` CLI (`$TOP_TAILSCALE` names another). */
export function systemCli(): TailscaleCli {
  const candidates = process.env.TOP_TAILSCALE ? [process.env.TOP_TAILSCALE] : (CANDIDATES[process.platform] ?? ["tailscale"]);
  let found: string | undefined;
  const run = (bin: string, args: readonly string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(bin, args, { timeout: 15_000, maxBuffer: 16 << 20, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(Object.assign(new Error(String(stderr).trim() || error.message), { missing }));
      });
    });
  return async (args) => {
    if (found) return run(found, args);
    let last: unknown;
    for (const bin of candidates) {
      try {
        const out = await run(bin, args);
        found = bin;
        return out;
      } catch (error) {
        if (!(error as { missing?: boolean }).missing) {
          found = bin;
          throw error;
        }
        last = error;
      }
    }
    throw Object.assign(new TailscaleError("Tailscale isn't installed (no `tailscale` command). Get it at https://tailscale.com/download."), { cause: last });
  };
}

// ── this device ──────────────────────────────────────────────────────────────────

export type TailnetSelf = {
  /** `box.tail1234.ts.net`, without the trailing dot. */
  readonly dnsName: string;
  /** `box` */
  readonly device: string;
  /** The device's stable id: a request from it is from this computer. */
  readonly stableId: string;
  readonly tags: readonly string[];
  /** The login of the person who owns this device; tagged devices have none. */
  readonly owner: string | undefined;
  /** HTTPS certificates are on for the tailnet (Serve needs them). */
  readonly https: boolean;
};

type StatusJson = {
  BackendState?: string;
  Self?: { ID?: string; DNSName?: string; UserID?: number; Tags?: string[] };
  User?: Record<string, { LoginName?: string }>;
  CertDomains?: string[] | null;
  CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
};

/** What `tailscale status --json` says about this device. Throws a TailscaleError when Top can't use it. */
export function parseStatus(json: string): TailnetSelf {
  const status = JSON.parse(json) as StatusJson;
  const state = status.BackendState;
  if (state === "NeedsLogin" || state === "NoState") throw new TailscaleError("Tailscale isn't signed in. Run `tailscale up`, then start Top again.");
  if (state !== "Running") throw new TailscaleError(`Tailscale is ${state ?? "not running"}. Run \`tailscale up\`, then start Top again.`);
  const self = status.Self;
  const dnsName = self?.DNSName?.replace(/\.$/, "");
  if (!self?.ID || !dnsName || status.CurrentTailnet?.MagicDNSEnabled === false)
    throw new TailscaleError("This tailnet has MagicDNS turned off, so the device has no name to serve at. Turn it on: https://login.tailscale.com/admin/dns");
  const tags = self.Tags ?? [];
  const users = status.User ?? {};
  const person = (login: string | undefined) => (login?.includes("@") ? login : undefined);
  const owner = tags.length === 0 ? person(users[String(self.UserID)]?.LoginName) : undefined;
  return {
    dnsName,
    device: dnsName.split(".")[0]!,
    stableId: self.ID,
    tags,
    owner,
    https: (status.CertDomains ?? []).includes(dnsName),
  };
}

// ── who is calling ───────────────────────────────────────────────────────────────

/** A device on the tailnet, as `tailscale whois` names it. */
export type Caller = {
  readonly stableId: string;
  /** `phone` */
  readonly device: string;
  /** `phone.tail1234.ts.net` */
  readonly dnsName: string;
  readonly tags: readonly string[];
  /** Its owner's login and name; a tagged device has none. */
  readonly login: string | undefined;
  readonly name: string | undefined;
};

type WhoisJson = {
  Node?: { StableID?: string; Name?: string; ComputedName?: string; Tags?: string[] };
  UserProfile?: { LoginName?: string; DisplayName?: string };
};

export function parseWhois(json: string): Caller | undefined {
  const { Node: node, UserProfile: user } = JSON.parse(json) as WhoisJson;
  if (!node?.StableID || !node.Name) return undefined;
  const dnsName = node.Name.replace(/\.$/, "");
  const tags = node.Tags ?? [];
  return {
    stableId: node.StableID,
    device: (node.ComputedName || dnsName.split(".")[0]!).toLowerCase(),
    dnsName,
    tags,
    login: tags.length === 0 && user?.LoginName?.includes("@") ? user.LoginName : undefined,
    name: tags.length === 0 ? user?.DisplayName : undefined,
  };
}

/** `--tailscale-allow` values: a login (`you@example.com`), a tag (`tag:laptops`), or a device (`phone`). */
export type AllowRule = { readonly kind: "login" | "tag" | "device"; readonly value: string };

export function parseAllow(values: readonly string[]): AllowRule[] {
  return values.flatMap((raw) =>
    raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((value): AllowRule => {
        if (value.startsWith("tag:")) return { kind: "tag", value };
        if (value.includes("@")) return { kind: "login", value: value.toLowerCase() };
        return { kind: "device", value: value.toLowerCase().replace(/\.$/, "") };
      }),
  );
}

export function allows(rules: readonly AllowRule[], caller: Caller): boolean {
  return rules.some((rule) => {
    if (rule.kind === "login") return caller.login?.toLowerCase() === rule.value;
    if (rule.kind === "tag") return caller.tags.includes(rule.value);
    return caller.device === rule.value || caller.dnsName.toLowerCase() === rule.value;
  });
}

const describe = (rule: AllowRule) => rule.value;
const callerName = (caller: Caller) => `${caller.device} (${caller.login ?? (caller.tags.join(", ") || "no owner")})`;

export type Admission = { readonly ok: true; readonly viewer: Viewer } | { readonly ok: false; readonly reason: string };

/** How long a whois answer (or a refusal) is reused for the same address. */
const WHOIS_TTL_MS = 30_000;
/** The HTTPS port on the tailnet: Top's own port, which is rarely taken by another Serve config (443 often is). */
export const TAILNET_PORT = 7357;

export type TailnetOptions = {
  readonly self: TailnetSelf;
  /**
   * Parsed `--tailscale-allow`. None: every device on the tailnet. Some: only those, and the device's
   * owner. This computer itself is always let in.
   */
  readonly allow: readonly AllowRule[];
  /** The HTTPS port on the tailnet. */
  readonly port?: number;
  readonly cli?: TailscaleCli;
  /** For tests: who an address is. Defaults to `tailscale whois`. */
  readonly whois?: (address: string) => Promise<Caller | undefined>;
};

export class Tailnet {
  readonly self: TailnetSelf;
  /** Empty: every device on the tailnet may connect. */
  readonly rules: readonly AllowRule[];
  readonly port: number;
  readonly #cli: TailscaleCli;
  readonly #whois: (address: string) => Promise<Caller | undefined>;
  readonly #cache = new Map<string, { at: number; caller: Promise<Caller | undefined> }>();
  /** Addresses already warned about, so a retrying client doesn't fill the log. */
  readonly #warned = new Map<string, number>();
  #exposed: number | undefined;

  constructor(options: TailnetOptions) {
    this.self = options.self;
    const owner = options.self.owner && options.allow.length ? [{ kind: "login" as const, value: options.self.owner.toLowerCase() }] : [];
    this.rules = [...owner, ...options.allow.filter((r) => !(r.kind === "login" && r.value === owner[0]?.value))];
    this.port = options.port ?? TAILNET_PORT;
    this.#cli = options.cli ?? systemCli();
    this.#whois =
      options.whois ??
      (async (address) => {
        try {
          return parseWhois(await this.#cli(["whois", "--json", address]));
        } catch {
          return undefined; // not a tailnet address (Funnel's public traffic), or whois failed
        }
      });
  }

  /** Where clients reach the daemon on the tailnet. */
  get url(): string {
    return `wss://${this.self.dnsName}${this.port === 443 ? "" : `:${this.port}`}`;
  }

  /** The HTTPS origin of `url`, for links (MCP sign-in redirects). */
  get origin(): string {
    return this.url.replace(/^wss:/, "https:");
  }

  /** Who may use Top, for the startup line. */
  describeAllowed(): string {
    return this.rules.length ? `${this.rules.map(describe).join(", ")} (and this computer)` : "every device on it";
  }

  /** Let a request on the tailnet port in, or say why not. */
  async admit(request: IncomingMessage): Promise<Admission> {
    const forwarded = request.headers["x-forwarded-for"];
    const address = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (!address) return { ok: false, reason: "Only Tailscale Serve reaches this port." };
    const now = Date.now();
    let cached = this.#cache.get(address);
    if (!cached || now - cached.at > WHOIS_TTL_MS) {
      cached = { at: now, caller: this.#whois(address) };
      this.#cache.set(address, cached);
      if (this.#cache.size > 1_000) for (const [key, value] of this.#cache) if (now - value.at > WHOIS_TTL_MS) this.#cache.delete(key);
    }
    const caller = await cached.caller;
    if (!caller) return this.#refuse(address, `${address} isn't on your tailnet.`);
    if (this.rules.length && caller.stableId !== this.self.stableId && !allows(this.rules, caller))
      return this.#refuse(
        address,
        `${callerName(caller)} isn't allowed to use Top on ${this.self.device}. Its owner can let it in with --tailscale-allow ${caller.login ?? caller.device}.`,
      );
    return {
      ok: true,
      viewer: {
        device: caller.device,
        ...(caller.login ? { login: caller.login } : {}),
        ...(caller.name ? { name: caller.name } : {}),
        ...(caller.tags.length ? { tags: [...caller.tags] } : {}),
      },
    };
  }

  #refuse(address: string, reason: string): Admission {
    const last = this.#warned.get(address) ?? 0;
    if (Date.now() - last > 60_000) {
      this.#warned.set(address, Date.now());
      console.warn(`[top] refused a tailnet connection: ${reason}`);
    }
    return { ok: false, reason };
  }

  /**
   * Point Tailscale Serve's `https://<device>:<port>` at the tailnet listener on `backendPort`. Refuses
   * to take over a port that serves something else, or one open to the internet with Funnel.
   */
  async expose(backendPort: number): Promise<void> {
    if (!this.self.https)
      throw new TailscaleError(
        "Tailscale Serve needs HTTPS certificates, which are off for this tailnet. Turn on HTTPS at https://login.tailscale.com/admin/dns, then start Top again.",
      );
    const target = `http://127.0.0.1:${backendPort}`;
    const host = `${this.self.dnsName}:${this.port}`;
    const config = JSON.parse((await this.#cli(["serve", "status", "--json"]).catch(() => "{}")) || "{}") as ServeConfig;
    if (config.AllowFunnel?.[host])
      throw new TailscaleError(
        `Funnel is on for https://${host}, which would put Top on the internet. Turn it off (\`tailscale funnel --https=${this.port} off\`) or pick another --tailscale-port.`,
      );
    const tcp = config.TCP?.[String(this.port)];
    const handlers = config.Web?.[host]?.Handlers ?? {};
    const ours = Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === target;
    if (tcp && !(tcp.HTTPS && (ours || Object.keys(handlers).length === 0))) {
      const what = Object.entries(handlers)
        .map(([path, h]) => `${path} → ${h.Proxy ?? h.Path ?? h.Text ?? "?"}`)
        .join(", ");
      throw new TailscaleError(
        `Port ${this.port} on the tailnet already serves something else${what ? ` (${what})` : tcp.TCPForward ? ` (${tcp.TCPForward})` : ""}. Pick another with --tailscale-port, or free it with \`tailscale serve --https=${this.port} off\`.`,
      );
    }
    try {
      await this.#cli(["serve", "--bg", `--https=${this.port}`, target]);
    } catch (error) {
      if (error instanceof TailscaleError) throw error;
      const message = (error as Error).message;
      const denied = /access denied|permission|operator|not allowed/i.test(message);
      throw new TailscaleError(
        denied
          ? `Tailscale won't let ${process.env.USER ?? "this user"} change Serve settings. Run \`sudo tailscale set --operator=$USER\` once, then start Top again.\n(${message})`
          : `Couldn't set up Tailscale Serve: ${message}`,
      );
    }
    this.#exposed = this.port;
  }

  /** Take Top off the tailnet (on a clean shutdown). */
  async unexpose(): Promise<void> {
    if (this.#exposed === undefined) return;
    const port = this.#exposed;
    this.#exposed = undefined;
    await this.#cli(["serve", `--https=${port}`, "off"]).catch((error: Error) => console.warn(`[top] couldn't turn off Tailscale Serve: ${error.message}`));
  }
}

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** Read this device's Tailscale state and set up who may connect. */
export async function connectTailnet(options: { allow: readonly string[]; port?: number; cli?: TailscaleCli }): Promise<Tailnet> {
  const cli = options.cli ?? systemCli();
  let status: string;
  try {
    status = await cli(["status", "--json"]);
  } catch (error) {
    if (error instanceof TailscaleError) throw error;
    throw new TailscaleError(`Can't reach Tailscale: ${(error as Error).message}. Is it running?`);
  }
  return new Tailnet({ self: parseStatus(status), allow: parseAllow(options.allow), cli, ...(options.port ? { port: options.port } : {}) });
}

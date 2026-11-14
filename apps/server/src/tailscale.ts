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
import type { Viewer } from "@top/protocol";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** A problem the user can fix: printed as is, without a stack. */
export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", { message: Schema.String }) {}

/** The `tailscale` CLI failed: `message` is its stderr, or why it couldn't start. */
export class TailscaleCommandError extends Schema.TaggedError<TailscaleCommandError>()("TailscaleCommandError", {
  message: Schema.String,
  /** There's no such program. */
  missing: Schema.Boolean,
}) {}

/** Runs the `tailscale` CLI and answers with its stdout. */
export type TailscaleCli = (args: readonly string[]) => Effect.Effect<string, TailscaleCommandError | TailscaleError>;

const CANDIDATES: Record<string, readonly string[]> = {
  darwin: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  win32: ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"],
};

/** The system's `tailscale` CLI (`$TOP_TAILSCALE` names another). */
export const systemCli: Effect.Effect<TailscaleCli, Config.ConfigError> = Effect.gen(function* () {
  const named = yield* Config.option(Config.String("TOP_TAILSCALE"));
  const candidates = Option.match(named, { onNone: () => CANDIDATES[process.platform] ?? ["tailscale"], onSome: (bin) => [bin] });
  let found: string | undefined;
  const run = (bin: string, args: readonly string[]) =>
    Effect.callback<string, TailscaleCommandError>((resume) => {
      execFile(bin, args, { timeout: 15_000, maxBuffer: 16 << 20, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resume(Effect.succeed(stdout));
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        resume(Effect.fail(new TailscaleCommandError({ message: String(stderr).trim() || error.message, missing })));
      });
    });
  const cli: TailscaleCli = (args) =>
    Effect.gen(function* () {
      if (found) return yield* run(found, args);
      for (const bin of candidates) {
        const result = yield* Effect.result(run(bin, args));
        if (result._tag === "Success") {
          found = bin;
          return result.success;
        }
        if (!result.failure.missing) {
          found = bin;
          return yield* result.failure;
        }
      }
      return yield* new TailscaleError({ message: "Tailscale isn't installed (no `tailscale` command). Get it at https://tailscale.com/download." });
    });
  return cli;
});

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
export function parseStatus(json: string): Effect.Effect<TailnetSelf, TailscaleError> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(parseStatusOrThrow(json));
    } catch (error) {
      return Schema.is(TailscaleError)(error) ? Effect.fail(error) : Effect.die(error);
    }
  });
}

function parseStatusOrThrow(json: string): TailnetSelf {
  const status = JSON.parse(json) as StatusJson;
  const state = status.BackendState;
  if (state === "NeedsLogin" || state === "NoState")
    throw new TailscaleError({ message: "Tailscale isn't signed in. Run `tailscale up`, then start Top again." });
  if (state !== "Running") throw new TailscaleError({ message: `Tailscale is ${state ?? "not running"}. Run \`tailscale up\`, then start Top again.` });
  const self = status.Self;
  const dnsName = self?.DNSName?.replace(/\.$/, "");
  if (!self?.ID || !dnsName || status.CurrentTailnet?.MagicDNSEnabled === false)
    throw new TailscaleError({
      message: "This tailnet has MagicDNS turned off, so the device has no name to serve at. Turn it on: https://login.tailscale.com/admin/dns",
    });
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
  readonly port?: number | undefined;
  readonly cli: TailscaleCli;
  /** For tests: who an address is. Defaults to `tailscale whois`. */
  readonly whois?: ((address: string) => Effect.Effect<Caller | undefined>) | undefined;
};

/** The headers of a request that reached the tailnet listener. */
export type RequestHeaders = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

export type Tailnet = {
  readonly self: TailnetSelf;
  /** Empty: every device on the tailnet may connect. */
  readonly rules: readonly AllowRule[];
  readonly port: number;
  /** Where clients reach the daemon on the tailnet. */
  readonly url: string;
  /** The HTTPS origin of `url`, for links (MCP sign-in redirects). */
  readonly origin: string;
  /** Who may use Top, for the startup line. */
  readonly describeAllowed: () => string;
  /** Let a request on the tailnet port in, or say why not. */
  readonly admit: (headers: RequestHeaders) => Effect.Effect<Admission>;
  /**
   * Point Tailscale Serve's `https://<device>:<port>` at the tailnet listener on `backendPort`, and take
   * it off again when the scope closes. Refuses to take over a port that serves something else, or one
   * open to the internet with Funnel.
   */
  readonly expose: (backendPort: number) => Effect.Effect<void, TailscaleError, Scope.Scope>;
};

export const makeTailnet = (options: TailnetOptions): Effect.Effect<Tailnet> =>
  Effect.gen(function* () {
    const { self, cli } = options;
    const owner = self.owner && options.allow.length ? [{ kind: "login" as const, value: self.owner.toLowerCase() }] : [];
    const rules: AllowRule[] = [...owner, ...options.allow.filter((r) => !(r.kind === "login" && r.value === owner[0]?.value))];
    const port = options.port ?? TAILNET_PORT;
    const url = `wss://${self.dnsName}${port === 443 ? "" : `:${port}`}`;
    const whois =
      options.whois ??
      ((address: string) =>
        cli(["whois", "--json", address]).pipe(
          Effect.map(parseWhois),
          // Not a tailnet address (Funnel's public traffic), or whois failed.
          Effect.orElseSucceed(() => undefined),
        ));
    const callers = yield* Cache.make({ lookup: whois, capacity: 1_000, timeToLive: Duration.millis(WHOIS_TTL_MS) });
    /** Addresses already warned about, so a retrying client doesn't fill the log. */
    const warned = new Map<string, number>();

    const refuse = (address: string, reason: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - (warned.get(address) ?? 0) > 60_000) {
          warned.set(address, now);
          yield* Effect.logWarning(`refused a tailnet connection: ${reason}`);
        }
        return { ok: false, reason } satisfies Admission;
      });

    return {
      self,
      rules,
      port,
      url,
      origin: url.replace(/^wss:/, "https:"),
      describeAllowed: () => (rules.length ? `${rules.map(describe).join(", ")} (and this computer)` : "every device on it"),
      admit: (headers) =>
        Effect.gen(function* () {
          const forwarded = headers["x-forwarded-for"];
          const address = (typeof forwarded === "string" ? forwarded : forwarded?.[0])?.split(",")[0]?.trim();
          if (!address) return { ok: false, reason: "Only Tailscale Serve reaches this port." } satisfies Admission;
          const caller = yield* Cache.get(callers, address);
          if (!caller) return yield* refuse(address, `${address} isn't on your tailnet.`);
          if (rules.length && caller.stableId !== self.stableId && !allows(rules, caller))
            return yield* refuse(
              address,
              `${callerName(caller)} isn't allowed to use Top on ${self.device}. Its owner can let it in with --tailscale-allow ${caller.login ?? caller.device}.`,
            );
          return {
            ok: true,
            viewer: {
              device: caller.device,
              ...(caller.login ? { login: caller.login } : {}),
              ...(caller.name ? { name: caller.name } : {}),
              ...(caller.tags.length ? { tags: [...caller.tags] } : {}),
            },
          } satisfies Admission;
        }),
      expose: (backendPort) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (!self.https)
              return yield* new TailscaleError({
                message:
                  "Tailscale Serve needs HTTPS certificates, which are off for this tailnet. Turn on HTTPS at https://login.tailscale.com/admin/dns, then start Top again.",
              });
            const target = `http://127.0.0.1:${backendPort}`;
            const host = `${self.dnsName}:${port}`;
            const status = yield* cli(["serve", "status", "--json"]).pipe(Effect.orElseSucceed(() => "{}"));
            const config = JSON.parse(status || "{}") as ServeConfig;
            if (config.AllowFunnel?.[host])
              return yield* new TailscaleError({
                message: `Funnel is on for https://${host}, which would put Top on the internet. Turn it off (\`tailscale funnel --https=${port} off\`) or pick another --tailscale-port.`,
              });
            const tcp = config.TCP?.[String(port)];
            const handlers = config.Web?.[host]?.Handlers ?? {};
            const ours = Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === target;
            if (tcp && !(tcp.HTTPS && (ours || Object.keys(handlers).length === 0))) {
              const what = Object.entries(handlers)
                .map(([path, h]) => `${path} → ${h.Proxy ?? h.Path ?? h.Text ?? "?"}`)
                .join(", ");
              return yield* new TailscaleError({
                message: `Port ${port} on the tailnet already serves something else${what ? ` (${what})` : tcp.TCPForward ? ` (${tcp.TCPForward})` : ""}. Pick another with --tailscale-port, or free it with \`tailscale serve --https=${port} off\`.`,
              });
            }
            yield* cli(["serve", "--bg", `--https=${port}`, target]).pipe(
              Effect.catchTag("TailscaleCommandError", (error) => {
                const denied = /access denied|permission|operator|not allowed/i.test(error.message);
                return Effect.fail(
                  new TailscaleError({
                    message: denied
                      ? `Tailscale won't let ${process.env.USER ?? "this user"} change Serve settings. Run \`sudo tailscale set --operator=$USER\` once, then start Top again.\n(${error.message})`
                      : `Couldn't set up Tailscale Serve: ${error.message}`,
                  }),
                );
              }),
            );
          }),
          // Take Top off the tailnet when it stops.
          () =>
            cli(["serve", `--https=${port}`, "off"]).pipe(Effect.catch((error) => Effect.logWarning(`couldn't turn off Tailscale Serve: ${error.message}`))),
        ),
    } satisfies Tailnet;
  });

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** Read this device's Tailscale state and set up who may connect. */
export const connectTailnet = (options: { allow: readonly string[]; port?: number | undefined; cli: TailscaleCli }): Effect.Effect<Tailnet, TailscaleError> =>
  Effect.gen(function* () {
    const status = yield* options
      .cli(["status", "--json"])
      .pipe(
        Effect.catchTag("TailscaleCommandError", (error) =>
          Effect.fail(new TailscaleError({ message: `Can't reach Tailscale: ${error.message}. Is it running?` })),
        ),
      );
    return yield* makeTailnet({ self: yield* parseStatus(status), allow: parseAllow(options.allow), cli: options.cli, port: options.port });
  });

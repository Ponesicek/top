import type { Viewer } from "@top/protocol";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class TailscaleError extends Schema.TaggedError<TailscaleError>()("TailscaleError", { message: Schema.String }) {}

export class TailscaleCommandError extends Schema.TaggedError<TailscaleCommandError>()("TailscaleCommandError", {
  message: Schema.String,
  missing: Schema.Boolean,
}) {}

export type TailscaleCli = (args: readonly string[]) => Effect.Effect<string, TailscaleCommandError | TailscaleError>;

const CANDIDATES: Record<string, readonly string[]> = {
  darwin: ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  win32: ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"],
};

const CLI_TIMEOUT_MS = 15_000;

export const systemCli: Effect.Effect<TailscaleCli, Config.ConfigError, ChildProcessSpawner.ChildProcessSpawner> = Effect.gen(function* () {
  const named = yield* Config.option(Config.String("TOP_TAILSCALE"));
  const candidates = Option.match(named, { onNone: () => CANDIDATES[process.platform] ?? ["tailscale"], onSome: (bin) => [bin] });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let found: string | undefined;
  const failed = (message: string, missing = false) => new TailscaleCommandError({ message, missing });
  const run = (bin: string, args: readonly string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(ChildProcess.make(bin, [...args]))
          .pipe(Effect.mapError((error) => failed(error.message, error.reason._tag === "NotFound")));
        const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString);
        const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: "unbounded" }).pipe(
          Effect.mapError((error) => failed(error instanceof Error ? error.message : String(error))),
        );
        if (code !== 0) return yield* failed(stderr.trim() || `tailscale ${args.join(" ")} exited with ${code}`);
        return stdout;
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(CLI_TIMEOUT_MS),
        orElse: () => Effect.fail(failed(`tailscale ${args.join(" ")} didn't answer in ${CLI_TIMEOUT_MS / 1000} s`)),
      }),
    );
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

export type TailnetSelf = {
  readonly dnsName: string;
  readonly device: string;
  readonly stableId: string;
  readonly tags: readonly string[];
  readonly owner: string | undefined;
  readonly https: boolean;
};

const Maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const Strings = Schema.Array(Schema.String);

const StatusJson = Schema.fromJsonString(
  Schema.Struct({
    BackendState: Maybe(Schema.String),
    Self: Maybe(Schema.Struct({ ID: Maybe(Schema.String), DNSName: Maybe(Schema.String), UserID: Maybe(Schema.Number), Tags: Maybe(Strings) })),
    User: Maybe(Schema.Record(Schema.String, Schema.Struct({ LoginName: Maybe(Schema.String) }))),
    CertDomains: Maybe(Strings),
    CurrentTailnet: Maybe(Schema.Struct({ MagicDNSEnabled: Maybe(Schema.Boolean) })),
  }),
);
const decodeStatus = Schema.decodeEffect(StatusJson);

export const parseStatus = (json: string): Effect.Effect<TailnetSelf, TailscaleError> =>
  Effect.gen(function* () {
    const status = yield* decodeStatus(json).pipe(
      Effect.mapError((error) => new TailscaleError({ message: `Can't read what \`tailscale status\` said: ${error.message}` })),
    );
    const state = status.BackendState;
    if (state === "NeedsLogin" || state === "NoState")
      return yield* new TailscaleError({ message: "Tailscale isn't signed in. Run `tailscale up`, then start Top again." });
    if (state !== "Running")
      return yield* new TailscaleError({ message: `Tailscale is ${state ?? "not running"}. Run \`tailscale up\`, then start Top again.` });
    const self = status.Self;
    const dnsName = self?.DNSName?.replace(/\.$/, "");
    if (!self?.ID || !dnsName || status.CurrentTailnet?.MagicDNSEnabled === false)
      return yield* new TailscaleError({
        message: "This tailnet has MagicDNS turned off, so the device has no name to serve at. Turn it on: https://login.tailscale.com/admin/dns",
      });
    const tags = self.Tags ?? [];
    const users = status.User ?? {};
    const person = (login: string | undefined) => (login?.includes("@") ? login : undefined);
    const owner = tags.length === 0 ? person(users[String(self.UserID)]?.LoginName ?? undefined) : undefined;
    return {
      dnsName,
      device: dnsName.split(".")[0]!,
      stableId: self.ID,
      tags,
      owner,
      https: (status.CertDomains ?? []).includes(dnsName),
    };
  });

export type Caller = {
  readonly stableId: string;
  readonly device: string;
  readonly dnsName: string;
  readonly tags: readonly string[];
  readonly login: string | undefined;
  readonly name: string | undefined;
};

const WhoisJson = Schema.fromJsonString(
  Schema.Struct({
    Node: Maybe(Schema.Struct({ StableID: Maybe(Schema.String), Name: Maybe(Schema.String), ComputedName: Maybe(Schema.String), Tags: Maybe(Strings) })),
    UserProfile: Maybe(Schema.Struct({ LoginName: Maybe(Schema.String), DisplayName: Maybe(Schema.String) })),
  }),
);
const decodeWhois = Schema.decodeSync(WhoisJson);

export function parseWhois(json: string): Caller | undefined {
  const { Node: node, UserProfile: user } = decodeWhois(json);
  if (!node?.StableID || !node.Name) return undefined;
  const dnsName = node.Name.replace(/\.$/, "");
  const tags = node.Tags ?? [];
  return {
    stableId: node.StableID,
    device: (node.ComputedName || dnsName.split(".")[0]!).toLowerCase(),
    dnsName,
    tags,
    login: tags.length === 0 && user?.LoginName?.includes("@") ? user.LoginName : undefined,
    name: tags.length === 0 ? (user?.DisplayName ?? undefined) : undefined,
  };
}

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

const WHOIS_TTL_MS = 30_000;
export const TAILNET_PORT = 7357;

export type TailnetOptions = {
  readonly self: TailnetSelf;
  readonly allow: readonly AllowRule[];
  readonly port?: number | undefined;
  readonly cli: TailscaleCli;
  readonly whois?: ((address: string) => Effect.Effect<Caller | undefined>) | undefined;
};

export type RequestHeaders = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

export type Tailnet = {
  readonly self: TailnetSelf;
  readonly rules: readonly AllowRule[];
  readonly port: number;
  readonly url: string;
  readonly origin: string;
  readonly describeAllowed: () => string;
  readonly admit: (headers: RequestHeaders) => Effect.Effect<Admission>;
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
          Effect.orElseSucceed(() => undefined),
        ));
    const callers = yield* Cache.make({ lookup: whois, capacity: 1_000, timeToLive: Duration.millis(WHOIS_TTL_MS) });
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
            const config = decodeServeConfig(status || "{}");
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
          () =>
            cli(["serve", `--https=${port}`, "off"]).pipe(Effect.catch((error) => Effect.logWarning(`couldn't turn off Tailscale Serve: ${error.message}`))),
        ),
    } satisfies Tailnet;
  });

const ServeConfig = Schema.fromJsonString(
  Schema.Struct({
    TCP: Maybe(Schema.Record(Schema.String, Schema.Struct({ HTTPS: Maybe(Schema.Boolean), TCPForward: Maybe(Schema.String) }))),
    Web: Maybe(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          Handlers: Maybe(Schema.Record(Schema.String, Schema.Struct({ Proxy: Maybe(Schema.String), Path: Maybe(Schema.String), Text: Maybe(Schema.String) }))),
        }),
      ),
    ),
    AllowFunnel: Maybe(Schema.Record(Schema.String, Schema.Boolean)),
  }),
);
const decodeServeConfig = Schema.decodeSync(ServeConfig);

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

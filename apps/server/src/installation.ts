import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Channel, channelName } from "@top/protocol";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { BUILD } from "./build.ts";

export const DEFAULT_MODEL = "openai/gpt-6.1-sol";
const SERVICE = "top.service";

export const installLayout = (home: string) => {
  const dir = join(home, "daemon");
  return {
    dir,
    versions: join(dir, "versions"),
    version: (version: string) => join(dir, "versions", version),
    current: join(dir, "current"),
    launcher: join(dir, "top-launch"),
    args: join(dir, "args"),
    channel: join(dir, "channel"),
    trial: join(dir, "trial"),
    rolledBack: join(dir, "rolled-back"),
    downloads: join(dir, "downloads"),
    backup: (version: string) => join(home, "server", `top.sqlite.before-${version}`),
  };
};
export type InstallLayout = ReturnType<typeof installLayout>;

export const LAUNCHER = `#!/bin/sh
# Starts the installed Top daemon; systemd runs this (see apps/server/src/installation.ts).
set -u
DIR="$(dirname "$(readlink -f "$0")")"
TOP_HOME="$(dirname "$DIR")"
export TOP_HOME
export TOP_DAEMON_DIR="$DIR"

if [ -f "$DIR/trial" ]; then
  read -r version previous starts < "$DIR/trial" || true
  starts=\${starts:-0}
  if [ "$starts" -ge 2 ] && [ -n "\${previous:-}" ] && [ -d "$DIR/versions/$previous" ]; then
    echo "top-launch: Top $version didn't start twice; going back to $previous" >&2
    db="$TOP_HOME/server/top.sqlite"
    backup="$TOP_HOME/server/top.sqlite.before-$version"
    if [ -f "$backup" ]; then
      for ext in "" -wal -shm; do
        if [ -e "$db$ext" ]; then mv -f "$db$ext" "$TOP_HOME/server/top.sqlite.failed-$version$ext"; fi
      done
      cp "$backup" "$db"
    fi
    ln -sfn "versions/$previous" "$DIR/current.tmp" && mv -Tf "$DIR/current.tmp" "$DIR/current"
    echo "$version" > "$DIR/rolled-back"
    rm -f "$DIR/trial"
  else
    echo "$version $previous $((starts + 1))" > "$DIR/trial"
  fi
fi

set --
if [ -f "$DIR/args" ]; then
  while IFS= read -r arg || [ -n "$arg" ]; do
    if [ -n "$arg" ]; then set -- "$@" "$arg"; fi
  done < "$DIR/args"
fi
exec "$DIR/current/bin/top" "$@"
`;

export const BIN_TOP = `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")/.."
exec "$HERE/node/bin/node" "$HERE/server.mjs" "$@"
`;

const unit = (launcher: string) => `[Unit]
Description=Top: runs your bots
After=network-online.target
Wants=network-online.target
# Updates restart it, and a version that won't start is rolled back by top-launch: never give up.
StartLimitIntervalSec=0

[Service]
ExecStart=${launcher}
Restart=always
RestartSec=2
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;

export const swapLink = (target: string, link: string) =>
  Effect.tryPromise({
    try: async () => {
      const tmp = `${link}.tmp`;
      await rm(tmp, { force: true });
      await symlink(target, tmp);
      await rename(tmp, link);
    },
    catch: (cause) => new InstallError({ message: `Couldn't switch versions: ${String(cause)}` }),
  });

export class InstallError extends Data.TaggedError("InstallError")<{ readonly message: string }> {}

const run = (command: string, args: readonly string[]) =>
  Effect.callback<string, InstallError>((resume) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) =>
      resume(error ? Effect.fail(new InstallError({ message: String(stderr).trim() || error.message })) : Effect.succeed(String(stdout))),
    );
  });

const io = <A>(what: string, promise: () => Promise<A>) =>
  Effect.tryPromise({ try: promise, catch: (cause) => new InstallError({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` }) });

export type InstallOptions = {
  readonly home: string;
  readonly args: readonly string[] | undefined;
  readonly start: boolean;
};

export const install = (options: InstallOptions) =>
  Effect.gen(function* () {
    if (!BUILD.channel || process.platform !== "linux")
      return yield* new InstallError({
        message:
          process.platform !== "linux"
            ? "Installing is for Linux for now. Run the daemon with `pnpm server` instead."
            : "This Top runs from a checkout. Install from a release: download top-daemon-<version>-linux-x64.tar.gz from https://github.com/Ponesicek/Top/releases, unpack it, and run bin/top install.",
      });
    const layout = installLayout(options.home);
    const source = dirname(fileURLToPath(import.meta.url));
    const target = layout.version(BUILD.version);
    if (!existsSync(join(source, "bin", "top"))) return yield* new InstallError({ message: `${source} isn't an unpacked release (it has no bin/top).` });

    yield* io("Couldn't make the install folder", () => mkdir(layout.versions, { recursive: true, mode: 0o700 }));
    if (resolve(source) !== resolve(target)) {
      yield* io("Couldn't remove an older copy of this version", () => rm(target, { recursive: true, force: true }));
      yield* io("Couldn't copy the release", () => cp(source, target, { recursive: true, verbatimSymlinks: true }));
    }
    yield* io("Couldn't write the launcher", async () => {
      await writeFile(layout.launcher, LAUNCHER);
      await chmod(layout.launcher, 0o755);
    });
    const args = options.args ?? (existsSync(layout.args) ? undefined : ["--model", DEFAULT_MODEL]);
    if (args) yield* io("Couldn't write the daemon's flags", () => writeFile(layout.args, `${args.join("\n")}\n`));
    if (!existsSync(layout.channel)) yield* io("Couldn't write the channel", () => writeFile(layout.channel, `${BUILD.channel}\n`));
    yield* io("Couldn't clear an earlier update", async () => {
      await rm(layout.trial, { force: true });
      await rm(layout.rolledBack, { force: true });
    });
    yield* swapLink(join("versions", BUILD.version), layout.current);

    const channel = yield* readChannel(layout);
    const flags = (yield* io("Couldn't read the daemon's flags", () => readFile(layout.args, "utf8"))).trim().split("\n").filter(Boolean);
    yield* Effect.log(`Installed Top ${BUILD.version} in ${layout.dir}, following ${channelName(channel)} releases.`);
    yield* Effect.log(`It runs with: ${flags.join(" ") || "(no flags)"}. Change them in ${layout.args}, then run: systemctl --user restart top`);

    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const unitPath = join(configHome, "systemd", "user", SERVICE);
    yield* io("Couldn't write the systemd service", async () => {
      await mkdir(dirname(unitPath), { recursive: true });
      await writeFile(unitPath, unit(layout.launcher));
    });
    const systemd = Effect.gen(function* () {
      yield* run("systemctl", ["--user", "daemon-reload"]);
      yield* run("systemctl", ["--user", "enable", SERVICE]);
      if (options.start) yield* run("systemctl", ["--user", "restart", SERVICE]);
    });
    yield* systemd.pipe(
      Effect.tap(() =>
        Effect.log(
          options.start
            ? "Started. Logs: journalctl --user -u top -f. To keep it running while you're logged out: loginctl enable-linger"
            : "Start it with: systemctl --user start top",
        ),
      ),
      Effect.catchTag("InstallError", (error) =>
        Effect.logWarning(`Couldn't start it with systemd (${error.message}). Wrote ${unitPath}; or run ${layout.launcher} yourself.`),
      ),
    );
  });

export const readChannel = (layout: InstallLayout): Effect.Effect<Channel> =>
  Effect.promise(() => readFile(layout.channel, "utf8").catch(() => "")).pipe(
    Effect.map((text): Channel => {
      const value = text.trim();
      return value === "stable" || value === "nightly" ? value : (BUILD.channel ?? "stable");
    }),
  );

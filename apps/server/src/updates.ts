/**
 * The installed daemon's updates (see installation.ts for where it lives). Only the user starts one,
 * from an app; the daemon only looks: when it starts, every 6 hours, and when asked.
 *
 * Installing a version: download its archive and check it against the release's SHA256SUMS, unpack it
 * next to the running one, back up the database, point `current` at it, and restart (systemd starts
 * it again). The bots stop where they are and pick their tasks back up on the new version, as after any
 * restart, except that this one doesn't count toward the restart limit. The new version is on trial
 * until it has run for 30 s; one that won't start is rolled back by the launcher.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CHECKSUMS,
  type Channel,
  channelName,
  channelOf,
  compareVersions,
  daemonArchive,
  RELEASE_REPO,
  releaseNotes,
  type UpdateRelease,
  type UpdateView,
} from "@top/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BUILD } from "./build.ts";
import { Events } from "./events.ts";
import { type InstallLayout, readChannel, swapLink } from "./installation.ts";
import { PLANNED_RESTART, Store } from "./store.ts";

const CHECK_EVERY = Duration.hours(6);
/** How long a new version runs before it's no longer on trial. */
const TRIAL = Duration.seconds(30);
const FIRST_CHECK = Duration.seconds(20);

export class UpdateError extends Data.TaggedError("UpdateError")<{ readonly message: string }> {}

export class Updates extends Context.Service<
  Updates,
  {
    readonly view: Effect.Effect<UpdateView>;
    readonly check: Effect.Effect<void, UpdateError>;
    /** Install `version`, the release `view.available` offers; ends with the daemon restarting. */
    readonly install: (version: string) => Effect.Effect<void, UpdateError>;
    readonly setChannel: (channel: Channel) => Effect.Effect<void, UpdateError>;
  }
>()("top/Updates") {}

// ── GitHub releases ─────────────────────────────────────────────────────────────

const Asset = Schema.Struct({ name: Schema.String, browser_download_url: Schema.String });
const Release = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  assets: Schema.Array(Asset),
});
export type GitHubRelease = typeof Release.Type;
const decodeReleases = Schema.decodeUnknownEffect(Schema.Array(Release));

/** A release the daemon can install: its notes, and where its archive and checksums are. */
export type Installable = UpdateRelease & { readonly archiveUrl: string; readonly checksumsUrl: string };

/**
 * The newest published release on `channel` that's newer than `current` and has this platform's
 * archive. A stable release is never offered on Nightly, nor a nightly on Stable.
 */
export function newestRelease(releases: readonly GitHubRelease[], channel: Channel, current: string): Installable | undefined {
  let best: Installable | undefined;
  for (const release of releases) {
    const version = release.tag_name.replace(/^v/, "");
    if (release.draft || channelOf(version) !== channel || release.prerelease !== (channel === "nightly")) continue;
    if (compareVersions(version, current) <= 0 || (best && compareVersions(version, best.version) <= 0)) continue;
    const archive = release.assets.find((a) => a.name === daemonArchive(version));
    const checksums = release.assets.find((a) => a.name === CHECKSUMS);
    if (!archive || !checksums) continue;
    best = {
      version,
      notes: releaseNotes(release.body),
      url: release.html_url,
      archiveUrl: archive.browser_download_url,
      checksumsUrl: checksums.browser_download_url,
    };
  }
  return best;
}

/** The checksum `SHA256SUMS` gives for `name`. */
export function checksumOf(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match && match[2] === name) return match[1]!.toLowerCase();
  }
  return undefined;
}

const HEADERS = { accept: "application/vnd.github+json", "user-agent": `top-daemon/${BUILD.version}` };

const failure = (what: string) => (cause: unknown) => new UpdateError({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` });

const sha256 = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const hash = createHash("sha256");
      await pipeline(createReadStream(path), hash);
      return hash.digest("hex");
    },
    catch: failure("Couldn't read the download"),
  });

const untar = (archive: string, into: string) =>
  Effect.callback<void, UpdateError>((resume) => {
    execFile("tar", ["-xzf", archive, "-C", into], { timeout: 120_000 }, (error, _stdout, stderr) =>
      resume(error ? Effect.fail(new UpdateError({ message: `Couldn't unpack the update: ${String(stderr).trim() || error.message}` })) : Effect.void),
    );
  });

// ── the service ─────────────────────────────────────────────────────────────────

export type UpdatesOptions = {
  readonly layout: InstallLayout;
  /** The GitHub releases API to ask (tests point it elsewhere). */
  readonly releasesUrl?: string;
  /** How the daemon restarts once the new version is in place (by default: SIGTERM to itself, and systemd starts it again). */
  readonly restart?: Effect.Effect<void>;
};

export const layer = (options: UpdatesOptions): Layer.Layer<Updates, never, Store | Events | HttpClient.HttpClient | FileSystem.FileSystem> =>
  Layer.effect(
    Updates,
    Effect.gen(function* () {
      const store = yield* Store;
      const events = yield* Events;
      const fs = yield* FileSystem.FileSystem;
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeaders(HEADERS)),
        // Release files redirect to GitHub's storage.
        HttpClient.followRedirects(5),
        HttpClient.filterStatusOk,
      );
      const get = (url: string, what: string) => http.get(url).pipe(Effect.mapError(failure(what)));
      const { layout } = options;
      const releasesUrl = options.releasesUrl ?? `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=50`;
      const restart = options.restart ?? Effect.sync(() => process.kill(process.pid, "SIGTERM"));

      let channel = yield* readChannel(layout);
      let state: UpdateView["state"] = "idle";
      let available: Installable | undefined;
      let checkedAt: number | undefined;
      let error: string | undefined;
      // The launcher left word that a version didn't start, and went back to this one.
      const rolledBack = yield* Effect.promise(() =>
        readFile(layout.rolledBack, "utf8").then(
          (text) => text.trim() || undefined,
          () => undefined,
        ),
      );
      if (rolledBack) {
        yield* Effect.promise(() => rm(layout.rolledBack, { force: true }));
        error = `Top ${rolledBack} didn't start, so the server went back to ${BUILD.version}.`;
        yield* Effect.logWarning(error);
      }

      const view = Effect.sync(
        (): UpdateView => ({
          channel,
          current: BUILD.version,
          state,
          ...(available ? { available: { version: available.version, notes: available.notes, url: available.url } } : {}),
          ...(checkedAt !== undefined ? { checkedAt } : {}),
          ...(error ? { error } : {}),
          ...(rolledBack ? { rolledBack } : {}),
        }),
      );
      const changed = Effect.flatMap(view, (v) => events.publish({ _tag: "Update", view: v }));
      const set = (next: UpdateView["state"], message?: string) =>
        Effect.suspend(() => {
          state = next;
          error = message;
          return changed;
        });
      const busy = () => state === "checking" || state === "downloading" || state === "restarting";

      const lookUp = Effect.gen(function* () {
        const response = yield* get(releasesUrl, "Couldn't reach GitHub");
        const json = yield* response.json.pipe(Effect.mapError(failure("GitHub's answer wasn't JSON")));
        const releases = yield* decodeReleases(json).pipe(Effect.mapError(failure("GitHub's answer was unexpected")));
        available = newestRelease(releases, channel, BUILD.version);
        checkedAt = yield* Clock.currentTimeMillis;
      });

      const check = Effect.gen(function* () {
        if (busy()) return;
        yield* set("checking");
        yield* lookUp.pipe(
          Effect.andThen(set("idle")),
          Effect.catchTag("UpdateError", (e) => Effect.andThen(set("failed", e.message), Effect.fail(e))),
        );
      }).pipe(Effect.withSpan("Updates.check"));

      const download = (release: Installable) =>
        Effect.gen(function* () {
          const name = daemonArchive(release.version);
          const archive = join(layout.downloads, name);
          yield* Effect.tryPromise({ try: () => mkdir(layout.downloads, { recursive: true }), catch: failure("Couldn't make the downloads folder") });
          const sums = yield* get(release.checksumsUrl, `Couldn't download ${release.version}'s checksums`).pipe(
            Effect.flatMap((response) => Effect.mapError(response.text, failure("Couldn't read the checksums"))),
          );
          const expected = checksumOf(sums, name);
          if (!expected) return yield* new UpdateError({ message: `The release has no checksum for ${name}.` });
          const response = yield* get(release.archiveUrl, `Couldn't download ${release.version}`);
          yield* Stream.run(response.stream, fs.sink(archive)).pipe(Effect.mapError(failure(`Couldn't download ${release.version}`)));
          if ((yield* sha256(archive)) !== expected)
            return yield* new UpdateError({ message: `The download of ${release.version} is damaged (its checksum doesn't match). Try again.` });

          // Unpacked beside the others, then renamed into place: a half-unpacked version is never `versions/<v>`.
          const unpacking = join(layout.versions, `.unpacking-${release.version}`);
          yield* Effect.tryPromise({
            try: async () => {
              await rm(unpacking, { recursive: true, force: true });
              await mkdir(unpacking, { recursive: true });
            },
            catch: failure("Couldn't make room for the update"),
          });
          yield* untar(archive, unpacking);
          yield* Effect.tryPromise({
            try: async () => {
              const [top] = await readdir(unpacking);
              if (!top) throw new Error("the archive is empty");
              await rm(layout.version(release.version), { recursive: true, force: true });
              await rename(join(unpacking, top), layout.version(release.version));
              await rm(unpacking, { recursive: true, force: true });
              await rm(archive, { force: true });
            },
            catch: failure("Couldn't put the update in place"),
          });
        });

      const install = (version: string) =>
        Effect.gen(function* () {
          if (busy()) return yield* new UpdateError({ message: "The server is already checking for or installing an update." });
          if (available?.version !== version) yield* check;
          const release = available;
          if (release?.version !== version)
            return yield* new UpdateError({ message: `Top ${version} isn't the newest ${channelName(channel)} release any more. Check again.` });

          yield* set("downloading");
          yield* download(release).pipe(Effect.catchTag("UpdateError", (e) => Effect.andThen(set("failed", e.message), Effect.fail(e))));

          // From here on the update happens: the database as it is now, kept to go back to, then the switch.
          yield* store.backup(layout.backup(version));
          yield* Effect.tryPromise({
            try: () => writeFile(layout.trial, `${version} ${BUILD.version} 0\n`),
            catch: failure("Couldn't start the update"),
          });
          yield* swapLink(join("versions", version), layout.current).pipe(Effect.mapError((e) => new UpdateError({ message: e.message })));
          yield* store.setFlag(PLANNED_RESTART);
          yield* set("restarting");
          yield* Effect.log(`updating to Top ${version}: restarting`);
          // Let the `restarting` frames go out before the connections close.
          yield* Effect.sleep(Duration.millis(300));
          yield* restart;
        }).pipe(Effect.withSpan("Updates.install", { attributes: { version } }));

      const setChannel = (next: Channel) =>
        Effect.gen(function* () {
          if (busy()) return yield* new UpdateError({ message: "Wait until the server has finished checking for or installing an update." });
          yield* Effect.tryPromise({ try: () => writeFile(layout.channel, `${next}\n`), catch: failure("Couldn't save the channel") });
          channel = next;
          available = undefined;
          yield* changed;
          yield* check.pipe(Effect.ignore);
        });

      // A new version that has run for a while is no longer on trial; the versions before the one it
      // replaced, and their database backups, go.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep(TRIAL);
          const trial = yield* Effect.promise(() => readFile(layout.trial, "utf8").catch(() => ""));
          const [version, previous] = trial.trim().split(/\s+/);
          if (version !== BUILD.version) return;
          yield* Effect.promise(() => rm(layout.trial, { force: true }));
          yield* Effect.promise(async () => {
            const keep = new Set([BUILD.version, previous]);
            for (const name of await readdir(layout.versions).catch(() => [] as string[]))
              if (!keep.has(name)) await rm(layout.version(name), { recursive: true, force: true });
            const server = join(layout.dir, "..", "server");
            for (const name of await readdir(server).catch(() => [] as string[]))
              if (/^top\.sqlite\.(before|failed)-/.test(name) && !name.endsWith(`before-${BUILD.version}`)) await rm(join(server, name), { force: true });
          });
          yield* Effect.log(`Top ${BUILD.version} is up; it's no longer on trial`);
        }),
      );
      yield* Effect.forkScoped(
        Effect.sleep(FIRST_CHECK).pipe(
          Effect.andThen(
            Effect.repeat(check.pipe(Effect.catchTag("UpdateError", (e) => Effect.logWarning(`update check: ${e.message}`))), Schedule.spaced(CHECK_EVERY)),
          ),
        ),
      );

      return Updates.of({ view, check, install, setChannel });
    }),
  );

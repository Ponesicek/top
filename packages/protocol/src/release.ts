/**
 * Top's releases: two channels, each built from its own branch and published as GitHub releases of
 * `RELEASE_REPO` by the Release workflow (.github/workflows/release.yml).
 *
 *   stable    from `main`:     v0.2.0                       a normal release, marked Latest
 *   nightly   from `nightly`:  v0.2.0-nightly.20261114.7    a prerelease: the next stable version, the UTC date, the run number
 *
 * The daemon and the desktop app each follow a channel of their own (a daemon serves many devices).
 * A build from a checkout follows none: it's "dev", and never updates.
 */

export const CHANNELS = ["stable", "nightly"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Where releases are published. */
export const RELEASE_REPO = "Ponesicek/Top";

export const channelName = (channel: Channel) => (channel === "stable" ? "Stable" : "Nightly");

type Version = { readonly core: readonly [number, number, number]; readonly nightly?: readonly [date: number, run: number] };

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?$/;

/** `0.2.0` or `0.2.0-nightly.20261114.7`; anything else (a dev build's `0.2.0-dev`) isn't a release. */
export function parseVersion(version: string): Version | undefined {
  const match = VERSION.exec(version.replace(/^v/, ""));
  if (!match) return undefined;
  const [, major, minor, patch, date, run] = match;
  return { core: [Number(major), Number(minor), Number(patch)], ...(date && run ? { nightly: [Number(date), Number(run)] as const } : {}) };
}

/** Which channel a release version is from. */
export function channelOf(version: string): Channel | undefined {
  const parsed = parseVersion(version);
  return parsed && (parsed.nightly ? "nightly" : "stable");
}

/**
 * Orders release versions as semver does: by `major.minor.patch`, and a nightly before the stable
 * release it leads up to (`0.2.0-nightly.*` < `0.2.0`). Nightlies of one version go by date, then run.
 * Something that isn't a release version sorts before every release.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.nightly || !y.nightly) return x.nightly ? -1 : y.nightly ? 1 : 0;
  return x.nightly[0] - y.nightly[0] || x.nightly[1] - y.nightly[1];
}

export const releaseTag = (version: string) => `v${version}`;
/** The daemon, with the Node it runs on: what `top install` and the daemon's updates unpack. */
export const daemonArchive = (version: string) => `top-daemon-${version}-linux-x64.tar.gz`;
/** The desktop app. An AppImage replaces itself, which is why it's the Linux format for now. */
export const desktopAppImage = (version: string) => `Top-${version}-x86_64.AppImage`;
/** `sha256  name` lines for every file of a release. */
export const CHECKSUMS = "SHA256SUMS";

/** A release's notes as the workflow writes them (`- <commit subject>` lines), as a list. */
export function releaseNotes(body: string | null | undefined): string[] {
  return (body ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      return match ? [match[1]!] : [];
    })
    .slice(0, 20);
}

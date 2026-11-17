export const CHANNELS = ["stable", "nightly"] as const;
export type Channel = (typeof CHANNELS)[number];

export const RELEASE_REPO = "Ponesicek/Top";

export const channelName = (channel: Channel) => (channel === "stable" ? "Stable" : "Nightly");

type Version = { readonly core: readonly [number, number, number]; readonly nightly?: readonly [date: number, run: number] };

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?$/;

export function parseVersion(version: string): Version | undefined {
  const match = VERSION.exec(version.replace(/^v/, ""));
  if (!match) return undefined;
  const [, major, minor, patch, date, run] = match;
  return { core: [Number(major), Number(minor), Number(patch)], ...(date && run ? { nightly: [Number(date), Number(run)] as const } : {}) };
}

export function channelOf(version: string): Channel | undefined {
  const parsed = parseVersion(version);
  return parsed && (parsed.nightly ? "nightly" : "stable");
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.nightly || !y.nightly) return x.nightly ? -1 : y.nightly ? 1 : 0;
  return x.nightly[0] - y.nightly[0] || x.nightly[1] - y.nightly[1];
}

export const releaseTag = (version: string) => `v${version}`;
export const daemonArchive = (version: string) => `top-daemon-${version}-linux-x64.tar.gz`;
export const desktopAppImage = (version: string) => `Top-${version}-x86_64.AppImage`;
export const CHECKSUMS = "SHA256SUMS";

export function releaseNotes(body: string | null | undefined): string[] {
  return (body ?? "")
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      return match ? [match[1]!] : [];
    })
    .slice(0, 20);
}

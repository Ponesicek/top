/**
 * A release's notes: the subject of every commit since the channel's previous release, one `- ` line
 * each (the daemon and the app show these lines when they offer the update; see `releaseNotes`).
 *
 *   node --import tsx scripts/release-notes.ts --channel nightly --tag v0.2.0-nightly.20261114.7 > notes.md
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { RELEASE_REPO } from "../packages/protocol/src/release.ts";

const { values } = parseArgs({ options: { channel: { type: "string" }, tag: { type: "string" } } });
if (values.channel !== "stable" && values.channel !== "nightly") throw new Error("--channel stable|nightly");
if (!values.tag) throw new Error("--tag vX.Y.Z…");

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let previous: string | undefined;
try {
  previous =
    values.channel === "nightly"
      ? git("describe", "--tags", "--abbrev=0", "--match", "v*-nightly.*")
      : git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*");
} catch {
  previous = undefined; // the channel's first release
}

const subjects = git("log", "--no-merges", "--format=%s", "-n", "40", ...(previous ? [`${previous}..HEAD`] : ["HEAD"]))
  .split("\n")
  .filter(Boolean)
  // A merged PR's commits already say what changed.
  .filter((s) => !/^Merge (pull request|branch)/.test(s));

const lines = subjects.length ? subjects.map((s) => `- ${s}`) : ["- No changes since the last release."];
process.stdout.write(`${lines.join("\n")}\n${previous ? `\n**All changes:** https://github.com/${RELEASE_REPO}/compare/${previous}...${values.tag}\n` : ""}`);

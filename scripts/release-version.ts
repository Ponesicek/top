/**
 * The version a release gets, from the root package.json's (the next stable version on `nightly`):
 *
 *   node --import tsx scripts/release-version.ts --channel stable                      0.2.0
 *   node --import tsx scripts/release-version.ts --channel nightly --run 7             0.2.0-nightly.20261114.7
 *   … --write    also puts it in every package.json, for the build (CI does this; it isn't committed)
 *
 * Prints `version=` and `tag=` lines, and appends them to $GITHUB_OUTPUT when it's set.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Channel, parseVersion, releaseTag } from "../packages/protocol/src/release.ts";

const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    run: { type: "string" },
    date: { type: "string" },
    write: { type: "boolean", default: false },
  },
});

const channel = values.channel as Channel;
if (channel !== "stable" && channel !== "nightly") throw new Error("--channel stable|nightly");
const root = new URL("../package.json", import.meta.url);
const base = (JSON.parse(readFileSync(root, "utf8")) as { version: string }).version;
const parsed = parseVersion(base);
if (!parsed || parsed.nightly) throw new Error(`package.json's version must be major.minor.patch (it's "${base}")`);

let version = base;
if (channel === "nightly") {
  const run = Number(values.run);
  if (!Number.isInteger(run) || run < 1) throw new Error("--run N (the workflow's run number) for a nightly");
  const date = values.date ?? new Date().toISOString().slice(0, 10).replaceAll("-", "");
  if (!/^\d{8}$/.test(date)) throw new Error("--date YYYYMMDD");
  version = `${base}-nightly.${date}.${run}`;
}

if (values.write) {
  for (const path of [
    "../package.json",
    "../apps/server/package.json",
    "../apps/desktop/package.json",
    "../packages/client/package.json",
    "../packages/protocol/package.json",
  ]) {
    const url = new URL(path, import.meta.url);
    const json = JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
    json.version = version;
    writeFileSync(url, `${JSON.stringify(json, null, 2)}\n`);
  }
}

const lines = `version=${version}\ntag=${releaseTag(version)}\nchannel=${channel}\n`;
process.stdout.write(lines);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);

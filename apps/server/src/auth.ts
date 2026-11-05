/**
 * Model credentials, shared with pi: the same `auth.json` that `pi` signs in to (`/login`), so a
 * ChatGPT, Copilot or Claude subscription pi already uses works here with no extra setup. API keys
 * from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, …) work too; pi-ai reads those itself.
 *
 * OAuth refresh tokens rotate, so every write goes through the same file lock pi takes. Otherwise the
 * daemon and pi could each refresh at once, and the loser would be signed out.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/** pi's credentials file: `$PI_CODING_AGENT_DIR/auth.json`, else `~/.pi/agent/auth.json`. */
export function piAuthPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, homedir()) ?? join(homedir(), ".pi", "agent");
  return join(dir, "auth.json");
}

type AuthFile = Record<string, Credential>;

export class PiAuthFile implements CredentialStore {
  readonly path: string;

  constructor(path = piAuthPath()) {
    this.path = path;
  }

  #load(): AuthFile {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8").replace(/^﻿/, "")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as AuthFile) : {};
    } catch {
      return {};
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.#load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.#load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.#locked((file) => fn(file[providerId]).then((next) => (next === undefined ? undefined : { ...file, [providerId]: next }))).then(
      () => this.#load()[providerId],
    );
  }

  async delete(providerId: string): Promise<void> {
    await this.#locked(async (file) => {
      if (!(providerId in file)) return undefined;
      const { [providerId]: _gone, ...rest } = file;
      return rest;
    });
  }

  /** Read-modify-write under pi's lock; `fn` returns the new file, or undefined to leave it. */
  async #locked(fn: (file: AuthFile) => Promise<AuthFile | undefined>): Promise<void> {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, "{}", { encoding: "utf8", mode: 0o600 });
    }
    const release = await lockfile.lock(this.path, { realpath: false, stale: 30_000, retries: { retries: 50, minTimeout: 20, maxTimeout: 1_000 } });
    try {
      const next = await fn(this.#load());
      if (next) writeFileSync(this.path, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    } finally {
      await release();
    }
  }
}

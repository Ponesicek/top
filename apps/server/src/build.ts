import { readFileSync } from "node:fs";
import { CHANNELS, type Channel } from "@top/protocol";

declare const __TOP_VERSION__: string | undefined;
declare const __TOP_CHANNEL__: string | undefined;

const released = typeof __TOP_VERSION__ === "string" && typeof __TOP_CHANNEL__ === "string";

const checkoutVersion = () => {
  try {
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof root.version === "string" ? `${root.version}-dev` : "dev";
  } catch {
    return "dev";
  }
};

export const BUILD: { readonly version: string; readonly channel: Channel | undefined } = released
  ? { version: __TOP_VERSION__, channel: (CHANNELS as readonly string[]).includes(__TOP_CHANNEL__) ? (__TOP_CHANNEL__ as Channel) : undefined }
  : { version: checkoutVersion(), channel: undefined };

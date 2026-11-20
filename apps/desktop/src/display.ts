// Settings Top no longer has: every conversation shows as a chat and every bot in its own color.
// Their stored values are dropped so nothing reads them again.
const REMOVED = ["top.chatStyle", "top.avatars"] as const;

export function forgetRemovedSettings(storage: Pick<Storage, "removeItem"> | undefined = safeStorage()) {
  try {
    for (const key of REMOVED) storage?.removeItem(key);
  } catch {}
}

function safeStorage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

export function readShowTools(): boolean {
  try {
    return localStorage.getItem("top.showTools") === "1";
  } catch {
    return false;
  }
}

export function saveShowTools(on: boolean) {
  try {
    localStorage.setItem("top.showTools", on ? "1" : "0");
  } catch {}
}

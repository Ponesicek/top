// Every conversation shows as a chat and every bot in its own color: a "top.chatStyle" or "top.avatars" an older
// version stored is left alone and not read.
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

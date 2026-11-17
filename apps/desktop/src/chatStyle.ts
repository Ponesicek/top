export type ChatStyle = "default" | "team" | "chat";

export const CHAT_STYLES: readonly { value: ChatStyle; label: string; description: string }[] = [
  { value: "default", label: "Default", description: "Answers as a column of text, your messages in bubbles." },
  { value: "team", label: "Team", description: "Everyone on the left, with names and times, like a team chat." },
  { value: "chat", label: "Chat", description: "Bubbles on both sides, like a messenger." },
];

const isStyle = (v: string | null | undefined): v is ChatStyle => v === "default" || v === "team" || v === "chat";

export function readChatStyle(): ChatStyle {
  const query = new URLSearchParams(location.search).get("style");
  if (isStyle(query)) return query;
  try {
    const saved = localStorage.getItem("top.chatStyle");
    return isStyle(saved) ? saved : "default";
  } catch {
    return "default";
  }
}

export function saveChatStyle(style: ChatStyle) {
  try {
    localStorage.setItem("top.chatStyle", style);
  } catch {}
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

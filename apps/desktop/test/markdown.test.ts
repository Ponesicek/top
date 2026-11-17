import { describe, expect, it } from "vitest";
import { botFilePath, renderMarkdown } from "../src/markdown.ts";

const srcOf = (markdown: string) => /src="([^"]*)"/.exec(renderMarkdown(markdown))?.[1] ?? "";

describe("botFilePath", () => {
  it("finds a bot's file named the way bots name them", () => {
    expect(botFilePath(srcOf("![Inline permission request](files/permission-inline-dark.png)"))).toBe("permission-inline-dark.png");
    expect(botFilePath("./files/report.html")).toBe("report.html");
    expect(botFilePath("files/chart.png?v=2#top")).toBe("chart.png");
  });

  it("decodes spaces and keeps subfolders", () => {
    expect(botFilePath(srcOf("![narrow](<files/shots dir/inline narrow.png>)"))).toBe("shots dir/inline narrow.png");
    expect(botFilePath("files/shots%20dir/inline%20narrow.png")).toBe("shots dir/inline narrow.png");
  });

  it("leaves remote images, other schemes and other paths alone", () => {
    for (const ref of [
      "https://example.com/files/a.png",
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "//evil.example/files/a.png",
      "/files/a.png",
      "images/a.png",
      "#files/a.png",
      "",
    ])
      expect(botFilePath(ref), ref).toBeUndefined();
  });

  it("never steps outside the files folder", () => {
    for (const ref of [
      "files/../secret.png",
      "files/./a.png",
      "files/%2e%2e/secret.png",
      "files/a%2F..%2F..%2Fsecret.png",
      "files/a%5Cb.png",
      "files/.hidden.png",
      "files/sub//a.png",
      "files/",
      "files/C:%5Cwindows.png",
      "files/bad%E0%A4%A.png",
    ])
      expect(botFilePath(ref), ref).toBeUndefined();
  });
});

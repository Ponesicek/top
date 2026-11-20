import { readFileSync } from "node:fs";
import type { BotStatus } from "@top/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, avatarMotion, avatarRhythm } from "../src/components/Avatar.tsx";

const STATUSES: readonly BotStatus[] = ["idle", "thinking", "tool", "retrying", "failed"];
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const draw = (status?: BotStatus) => renderToStaticMarkup(createElement(Avatar, { name: "Atlas", status }));
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("avatar motion", () => {
  it("gives every bot status its own motion, and none to an avatar without a status", () => {
    expect(STATUSES.map(avatarMotion)).toEqual(["calm", "pondering", "busy", "strained", "down"]);
    expect(avatarMotion(undefined)).toBeUndefined();
  });

  it("marks the avatar with its motion and keeps the same drawing in every state", () => {
    const plain = draw();
    expect(plain).not.toContain("data-state");
    expect(plain).not.toContain("--avatar-phase");
    const art = (html: string) => html.slice(html.indexOf("<svg"), html.lastIndexOf("</svg>"));
    for (const status of STATUSES) {
      const html = draw(status);
      expect(html).toContain(`data-state="${avatarMotion(status)}"`);
      expect(html).toContain('aria-hidden="true"');
      expect(art(html)).toBe(art(plain));
    }
  });

  it("gives each bot a steady rhythm of its own", () => {
    expect(avatarRhythm("Atlas")).toEqual(avatarRhythm("Atlas"));
    const phases = ["Atlas", "Juniper", "Moss", "Quill", "Vesper"].map((name) => avatarRhythm(name).phase);
    for (const phase of phases) expect(phase >= 0 && phase <= 1).toBe(true);
    expect(new Set(phases).size).toBeGreaterThan(1);
  });

  it("has a style for every motion, and only moves a bot that is idle or working", () => {
    for (const status of STATUSES) expect(css).toContain(`.avatar[data-state="${avatarMotion(status)}"]`);
    expect(rule('.avatar[data-state="down"] .avatar-body')).not.toContain("animation");
    expect(css).not.toMatch(/\[data-state="down"\][^{]*\{[^}]*running/);
    expect(rule(":root[data-offline] .avatar[data-state] :is(.avatar-body, .avatar-eyes, .avatar-lids)")).toContain("animation-play-state: paused");
    expect(rule(".avatar[data-state] :is(.avatar-body, .avatar-eyes, .avatar-lids)")).toContain("animation-play-state: paused");
  });

  it("stops all motion when reduced motion is asked for, keeping each state's pose", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce) {\n    .avatar[data-state]");
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toContain(".avatar[data-state] :is(.avatar-body, .avatar-eyes, .avatar-lids)");
    expect(block).toContain("animation: none");
    expect(block).toContain("transition: none");
    expect(block).not.toContain("transform");
  });
});

/**
 * The composer's skill picker: typing `/` at the start of a message lists the bot's skills (the ones
 * switched on for it, in Settings → Skills), and picking one writes `/<name> ` to ask for it.
 */
import type { ActiveSkill } from "@top/client";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";

/**
 * Fixed over the composer box (`anchor`), since the composer's dock clips what overflows it. Placed
 * from the box's position, again when the window resizes.
 */
export function SkillMenu({
  anchor,
  id,
  skills,
  picked,
  onPick,
  onHover,
}: {
  anchor: RefObject<HTMLElement | null>;
  id: string;
  skills: readonly ActiveSkill[];
  picked: number;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number; bottom: number }>();
  useLayoutEffect(() => {
    const measure = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (box) setPlace({ left: box.left, width: box.width, bottom: window.innerHeight - box.top + 6 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${picked}"]`)?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label="Skills"
      style={place ?? { visibility: "hidden" }}
      className="fixed z-40 flex max-h-64 flex-col gap-px overflow-y-auto rounded-xl bg-popover p-1 shadow-popover inset-ring inset-ring-border"
    >
      {skills.map((skill, i) => (
        // biome-ignore lint/a11y/useFocusableInteractive: the field keeps focus and the keyboard (arrows, Enter, Tab), pointing at the option with aria-activedescendant
        <div
          key={skill.name}
          id={`${id}-${i}`}
          data-index={i}
          role="option"
          aria-selected={i === picked}
          // Pressing an option keeps the field's focus and caret.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(skill.name);
          }}
          onMouseMove={() => i !== picked && onHover(i)}
          className={cn("flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.75", i === picked && "bg-secondary")}
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-foreground">/{skill.name}</span>
            <span className="text-micro text-muted-foreground">{skill.source === "shared" ? "shared" : "own"}</span>
          </span>
          <span className="line-clamp-1 text-meta text-muted-foreground">{skill.description}</span>
        </div>
      ))}
    </div>
  );
}

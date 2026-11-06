import { type ReactNode, useId } from "react";
import { CHAT_STYLES, type ChatStyle } from "../chatStyle.ts";
import { cn } from "../lib/utils.ts";
import { canScale, SCALES, type Scale } from "../scale.ts";
import { McpServers } from "./McpServers.tsx";

const SCALE_OPTIONS = SCALES.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }));

import { Section } from "./SettingsSection.tsx";
import { Switch } from "./ui/switch.tsx";

/** One setting: a label and a line about it on the left, its control on the right. */
function Row({
  label,
  description,
  control,
}: {
  label: string;
  description?: ReactNode;
  control: (ids: { labelId: string; descriptionId: string }) => ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-between gap-6 px-4.5 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-small leading-snug font-label">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="text-meta text-muted-foreground">
            {description}
          </span>
        )}
      </div>
      {control({ labelId, descriptionId })}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm bg-secondary px-1 py-px font-mono text-[11px] text-secondary-foreground">{children}</kbd>;
}

/** The settings page fills the main area, in place of a conversation. */
/** A few buttons in a track, the chosen one raised. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  labelledBy: string;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-none gap-0.5 rounded-field bg-secondary p-0.75">
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control; TODO: Base UI RadioGroup, which adds arrow-key navigation
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[7px] px-3 py-1 text-meta font-label text-secondary-foreground transition-colors duration-120 hover:text-foreground",
            o.value === value && "bg-popover text-foreground shadow-row-selected",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Settings({
  perfHud,
  onPerfHudChange,
  chatStyle,
  onChatStyleChange,
  showTools,
  onShowToolsChange,
  scale,
  onScaleChange,
}: {
  perfHud: boolean;
  onPerfHudChange: (on: boolean) => void;
  chatStyle: ChatStyle;
  onChatStyleChange: (style: ChatStyle) => void;
  showTools: boolean;
  onShowToolsChange: (on: boolean) => void;
  scale: Scale;
  onScaleChange: (scale: Scale) => void;
}) {
  return (
    <>
      <header className="h-15 flex-none border-b [scrollbar-gutter:stable] [-webkit-app-region:drag]">
        <div className="clear-window-controls mx-auto flex h-full max-w-170 items-center pl-8 [--column:42.5rem]">
          <h1 className="m-0 text-base leading-tight font-heading tracking-name">Settings</h1>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto flex max-w-170 flex-col gap-8 px-8 py-7">
          <Section title="Appearance">
            <Row
              label="Conversation style"
              description={CHAT_STYLES.find((s) => s.value === chatStyle)?.description}
              control={({ labelId }) => <Segmented value={chatStyle} options={CHAT_STYLES} onChange={onChatStyleChange} labelledBy={labelId} />}
            />
            <Row
              label="Show tool calls"
              description="The steps a bot takes while it works, as a line you can open."
              control={({ labelId, descriptionId }) => (
                <Switch checked={showTools} onCheckedChange={onShowToolsChange} aria-labelledby={labelId} aria-describedby={descriptionId} />
              )}
            />
            {canScale && (
              <Row
                label="Interface size"
                description={
                  <>
                    Text and controls, all at once. <Kbd>Ctrl+=</Kbd> <Kbd>Ctrl+-</Kbd>
                  </>
                }
                control={({ labelId }) => (
                  <Segmented value={String(scale)} options={SCALE_OPTIONS} onChange={(value) => onScaleChange(Number(value) as Scale)} labelledBy={labelId} />
                )}
              />
            )}
          </Section>
          <McpServers />
          <Section title="Performance">
            <Row
              label="Performance overlay"
              description={
                <>
                  Frame rate, input latency, long tasks and round-trip time, in the top-right corner. <Kbd>Ctrl+Shift+P</Kbd>
                </>
              }
              control={({ labelId, descriptionId }) => (
                <Switch checked={perfHud} onCheckedChange={onPerfHudChange} aria-labelledby={labelId} aria-describedby={descriptionId} />
              )}
            />
          </Section>
        </div>
      </div>
    </>
  );
}

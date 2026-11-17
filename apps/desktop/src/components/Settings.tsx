import type { ReactNode } from "react";
import { AVATAR_STYLES, type AvatarStyle } from "../avatarStyle.ts";
import { CHAT_STYLES, type ChatStyle } from "../chatStyle.ts";
import { canScale, SCALES, type Scale } from "../scale.ts";
import { AccountSection } from "./ChatGPT.tsx";
import { DaemonSettings } from "./DaemonSettings.tsx";
import { McpServers } from "./McpServers.tsx";
import { Skills } from "./Skills.tsx";

const SCALE_OPTIONS = SCALES.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }));

import { Row, Section, Segmented } from "./SettingsSection.tsx";
import { UpdateSettings } from "./UpdateSettings.tsx";
import { Switch } from "./ui/switch.tsx";

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm bg-secondary px-1 py-px font-mono text-[11px] text-secondary-foreground">{children}</kbd>;
}

/** The settings page fills the main area, in place of a conversation. */
export function Settings({
  perfHud,
  onPerfHudChange,
  chatStyle,
  onChatStyleChange,
  showTools,
  onShowToolsChange,
  avatarStyle,
  onAvatarStyleChange,
  scale,
  onScaleChange,
}: {
  perfHud: boolean;
  onPerfHudChange: (on: boolean) => void;
  chatStyle: ChatStyle;
  onChatStyleChange: (style: ChatStyle) => void;
  showTools: boolean;
  onShowToolsChange: (on: boolean) => void;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => void;
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
              label="Bot avatars"
              description={AVATAR_STYLES.find((s) => s.value === avatarStyle)?.description}
              control={({ labelId }) => <Segmented value={avatarStyle} options={AVATAR_STYLES} onChange={onAvatarStyleChange} labelledBy={labelId} />}
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
          <AccountSection />
          <McpServers />
          <Skills />
          <DaemonSettings />
          <UpdateSettings />
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

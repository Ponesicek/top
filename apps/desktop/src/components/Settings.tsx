import { canScale, SCALES, type Scale } from "../scale.ts";
import { AccountSection } from "./ChatGPT.tsx";
import { DaemonSettings } from "./DaemonSettings.tsx";
import { McpServers } from "./McpServers.tsx";
import { Row, Section, Segmented } from "./SettingsSection.tsx";
import { Skills } from "./Skills.tsx";
import { UpdateSettings } from "./UpdateSettings.tsx";
import { Switch } from "./ui/switch.tsx";

const SCALE_OPTIONS = SCALES.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` }));

export function Settings({
  perfHud,
  onPerfHudChange,
  showTools,
  onShowToolsChange,
  scale,
  onScaleChange,
}: {
  perfHud: boolean;
  onPerfHudChange: (on: boolean) => void;
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
              label="Show tool calls"
              control={({ labelId }) => <Switch checked={showTools} onCheckedChange={onShowToolsChange} aria-labelledby={labelId} />}
            />
            {canScale && (
              <Row
                label="Interface size"
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
              control={({ labelId }) => <Switch checked={perfHud} onCheckedChange={onPerfHudChange} aria-labelledby={labelId} />}
            />
          </Section>
        </div>
      </div>
    </>
  );
}

import { useId, type ReactNode } from "react";
import { Switch } from "./ui/switch.tsx";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="m-0 px-1 text-micro font-semibold text-secondary-foreground">{title}</h2>
      <div className="flex flex-col divide-y rounded-2xl bg-popover inset-ring inset-ring-border">{children}</div>
    </section>
  );
}

/** One setting: a label and a line about it on the left, its control on the right. */
function Row({ label, description, control }: { label: string; description?: ReactNode; control: (ids: { labelId: string; descriptionId: string }) => ReactNode }) {
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
export function Settings({ perfHud, onPerfHudChange }: { perfHud: boolean; onPerfHudChange: (on: boolean) => void }) {
  return (
    <>
      <header className="h-15 flex-none border-b [scrollbar-gutter:stable] [-webkit-app-region:drag]">
        <div className="mx-auto flex h-full max-w-170 items-center px-8">
          <h1 className="m-0 text-base leading-tight font-heading tracking-name">Settings</h1>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto flex max-w-170 flex-col gap-8 px-8 py-7">
          <Section title="Performance">
            <Row
              label="Performance overlay"
              description={
                <>
                  Frame rate, input latency, long tasks and round-trip time, in the top-right corner. <Kbd>Ctrl+Shift+P</Kbd>
                </>
              }
              control={({ labelId, descriptionId }) => <Switch checked={perfHud} onCheckedChange={onPerfHudChange} aria-labelledby={labelId} aria-describedby={descriptionId} />}
            />
          </Section>
        </div>
      </div>
    </>
  );
}

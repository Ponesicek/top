import { type ReactNode, useId } from "react";
import { cn } from "../lib/utils.ts";

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-4 px-1">
        <h2 className="m-0 text-micro font-semibold text-secondary-foreground">{title}</h2>
        {action}
      </div>
      <div className="flex flex-col divide-y rounded-2xl bg-popover inset-ring inset-ring-border">{children}</div>
    </section>
  );
}

export function Row({
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
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4.5 py-3.5">
      <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
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

export function BotChip({
  on,
  disabled,
  title,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean | undefined;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-6.5 items-center gap-1.5 rounded-full px-2.5 text-meta leading-none font-label transition-colors duration-90 outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-55",
        on ? "bg-primary-soft text-link inset-ring inset-ring-primary/35" : "bg-secondary text-muted-foreground enabled:hover:text-foreground",
      )}
    >
      <i className={cn("size-1.5 rounded-full", on ? "bg-primary" : "inset-ring-[1.5px] inset-ring-current")} aria-hidden />
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
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
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex max-w-full flex-none gap-0.5 overflow-x-auto rounded-field bg-secondary p-0.75">
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control; TODO: Base UI RadioGroup, which adds arrow-key navigation
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-none rounded-[7px] px-3 py-1 text-meta font-label narrow:min-h-11 text-secondary-foreground transition-colors duration-120 hover:text-foreground",
            o.value === value && "bg-popover text-foreground shadow-row-selected",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

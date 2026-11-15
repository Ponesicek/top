import { type ReactNode, useId } from "react";
import { cn } from "../lib/utils.ts";

/** A titled card of settings rows; `action` sits at the right of the title. */
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

/** One setting: a label and a line about it on the left, its control on the right. */
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

/** A few buttons in a track, the chosen one raised. */
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

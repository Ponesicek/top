import type { ReactNode } from "react";

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

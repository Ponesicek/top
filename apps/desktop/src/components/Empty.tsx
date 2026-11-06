import type { ReactNode } from "react";

/** A centered message over the main area: no bots yet, a new bot's first screen, waiting to connect. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-muted-foreground">{children}</div>;
}

export function EmptyCard({ visual, title, children, action }: { visual?: ReactNode; title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex max-w-80 flex-col items-center gap-1 text-center">
      {visual}
      {title && <h2 className="mt-3 text-[19px] leading-tight font-heading tracking-title text-foreground">{title}</h2>}
      <p className="mt-1 text-small text-muted-foreground">{children}</p>
      {action && <div className="pointer-events-auto mt-4">{action}</div>}
    </div>
  );
}

/** The line under a turn that says which files the bot's folder gained or changed; each one opens in the Files panel. */
import type { BotId } from "@top/client";
import { memo } from "react";
import { nameOf, openFile } from "../../files.ts";
import { cn } from "../../lib/utils.ts";
import type { FilesRow } from "../../rows.ts";
import { FileIcon } from "./FileIcon.tsx";

const SHOWN = 4;
const LABEL = { added: "new", changed: "updated", removed: "removed" } as const;

export const FilesLine = memo(function FilesLine({ row, bot, className }: { row: FilesRow; bot: BotId; className?: string }) {
  // New and updated files first: they're the ones worth opening.
  const files = [...row.files].sort((a, b) => Number(a.change === "removed") - Number(b.change === "removed"));
  const shown = files.slice(0, SHOWN);
  const rest = files.length - shown.length;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 py-1.5 text-meta leading-snug", className)}>
      {shown.map(({ path, change }) =>
        change === "removed" ? (
          <span key={path} className="inline-flex h-6.5 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground" title={path}>
            <FileIcon path={path} size={13} />
            <span className="max-w-60 truncate line-through">{nameOf(path)}</span>
            <span>{LABEL[change]}</span>
          </span>
        ) : (
          <button
            key={path}
            type="button"
            className="inline-flex h-6.5 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 font-label text-secondary-foreground inset-ring inset-ring-border transition-colors duration-90 hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            title={`Open ${path}`}
            onClick={() => openFile(bot, path)}
          >
            <FileIcon path={path} size={13} />
            <span className="max-w-60 truncate">{nameOf(path)}</span>
            <span className="font-book text-muted-foreground">{LABEL[change]}</span>
          </button>
        ),
      )}
      {rest > 0 && <span className="text-muted-foreground">and {rest} more</span>}
    </div>
  );
});

import { EyeOutlined } from "@ant-design/icons";
import type { ViewerPresence } from "~/game/protocol/messages";

export function ViewerList({
  viewers,
  expanded,
  onToggle,
  className = "",
}: {
  viewers: ViewerPresence[];
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}): React.ReactElement {
  const spectators = viewers.filter((viewer) => viewer.role === "spectator");
  const toggleLabel = expanded ? "Hide viewer list" : "Show viewer list";
  return (
    <aside
      className={`pointer-events-auto z-30 flex max-h-full min-h-0 w-48 flex-col overflow-hidden rounded bg-black/65 text-white shadow-lg backdrop-blur-sm ${className}`}
      aria-label="Current viewers"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        title={toggleLabel}
        className={`flex h-8 w-full shrink-0 items-center gap-2 px-3 text-xs font-semibold transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300/80 ${
          expanded && spectators.length > 0
            ? "border-b border-white/10"
            : ""
        }`}
      >
        <EyeOutlined
          aria-hidden="true"
          className={expanded ? "opacity-90" : "opacity-50"}
        />
        <span>Viewers</span>
        <span className="ml-auto tabular-nums text-white/60">
          {spectators.length}
        </span>
      </button>
      {expanded && spectators.length > 0 && (
        <ul className="min-h-0 overflow-y-auto py-1">
          {spectators.map((viewer) => {
            const delayMinutes =
              viewer.delayMs && viewer.delayMs > 0
                ? Math.max(1, Math.round(viewer.delayMs / 60_000))
                : 0;
            return (
              <li
                key={viewer.userId}
                className="flex h-7 shrink-0 items-center gap-2 px-3 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {viewer.displayName}
                </span>
                <span
                  className={`text-[10px] uppercase ${
                    delayMinutes > 0
                      ? "text-amber-300/70"
                      : "text-red-300/70"
                  }`}
                >
                  {delayMinutes > 0 ? `${delayMinutes} min delay` : "live"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
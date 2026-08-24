import { EyeOutlined } from "@ant-design/icons";
import type { ViewerPresence } from "~/game/protocol/messages";

export function ViewerListToggle({
  visible,
  onToggle,
  className = "",
}: {
  visible: boolean;
  onToggle: () => void;
  className?: string;
}): React.ReactElement {
  const label = visible ? "Hide viewer list" : "Show viewer list";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={visible}
      title={label}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:bg-white/10 hover:opacity-100 ${
        visible ? "opacity-90" : "opacity-40"
      } ${className}`}
    >
      <EyeOutlined aria-hidden="true" />
    </button>
  );
}

export function ViewerList({
  viewers,
  className = "",
}: {
  viewers: ViewerPresence[];
  className?: string;
}): React.ReactElement | null {
  const spectators = viewers.filter((viewer) => viewer.role === "spectator");
  if (spectators.length === 0) {
    return null;
  }
  return (
    <aside
      className={`pointer-events-auto z-30 w-48 overflow-hidden rounded bg-black/65 text-white shadow-lg backdrop-blur-sm ${className}`}
      aria-label="Current viewers"
    >
      <div className="flex h-8 items-center gap-2 border-b border-white/10 px-3 text-xs font-semibold">
        <EyeOutlined aria-hidden="true" />
        <span>Viewers</span>
        <span className="ml-auto tabular-nums text-white/60">
          {spectators.length}
        </span>
      </div>
      <ul className="max-h-40 overflow-y-auto py-1">
        {spectators.map((viewer) => {
          const delayMinutes =
            viewer.delayMs && viewer.delayMs > 0
              ? Math.max(1, Math.round(viewer.delayMs / 60_000))
              : 0;
          return (
            <li
              key={viewer.userId}
              className="flex h-7 items-center gap-2 px-3 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">
                {viewer.displayName}
              </span>
              <span
                className={`text-[10px] uppercase ${
                  delayMinutes > 0 ? "text-amber-300/70" : "text-red-300/70"
                }`}
              >
                {delayMinutes > 0 ? `${delayMinutes} min delay` : "live"}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
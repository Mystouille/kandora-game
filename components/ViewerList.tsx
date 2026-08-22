import { EyeOutlined } from "@ant-design/icons";
import type { ViewerPresence } from "~/game/protocol/messages";

export function ViewerList({
  viewers,
  className = "",
}: {
  viewers: ViewerPresence[];
  className?: string;
}): React.ReactElement | null {
  if (viewers.length === 0) {
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
          {viewers.length}
        </span>
      </div>
      <ul className="max-h-40 overflow-y-auto py-1">
        {viewers.map((viewer) => (
          <li
            key={viewer.userId}
            className="flex h-7 items-center gap-2 px-3 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">
              {viewer.displayName}
            </span>
            <span className="text-[10px] uppercase text-white/45">
              {viewer.role === "player" ? "playing" : "watching"}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
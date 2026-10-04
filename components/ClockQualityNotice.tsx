import { useEffect, useState } from "react";
import { liveClockQuality } from "~/game/client/time/liveClock";

export function ClockQualityNotice({
  clockEpoch,
  inline = false,
}: {
  clockEpoch?: string;
  inline?: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!clockEpoch) {
      setMessage(null);
      return;
    }
    const refresh = (): void => {
      const quality = liveClockQuality();
      setMessage(
        quality?.clockEpoch !== clockEpoch
          ? "Synchronizing game clock"
          : quality.roundTripMs > 500 || quality.uncertaintyMs > 250
            ? "Network timing degraded"
            : null
      );
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, [clockEpoch]);
  return message === null ? null : (
    <div
      role="status"
      className="web-table-clock-notice"
      style={{
        position: inline ? "static" : "absolute",
        top: 24,
        left: 12,
        zIndex: 40,
        pointerEvents: "none",
        background: "rgba(0,0,0,0.75)",
        color: "#facc15",
        padding: "var(--web-ui-notice-padding, 5px 8px)",
        borderRadius: 5,
        fontSize: "var(--web-ui-detail, 12px)",
      }}
    >
      {message}
    </div>
  );
}

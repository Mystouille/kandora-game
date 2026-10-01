import { useEffect, useState } from "react";
import type { ActionWindowView } from "~/game/protocol/timing";
import { promptCountdown } from "./liveTimingBinding";

export function usePromptCountdown(
  window: ActionWindowView | null | undefined,
  deadline: number | null
) {
  const [countdown, setCountdown] = useState(() =>
    deadline === null
      ? { remainingMs: 0, canRespond: false, synchronized: true }
      : promptCountdown(window, deadline)
  );
  useEffect(() => {
    if (deadline === null) {
      setCountdown({ remainingMs: 0, canRespond: false, synchronized: true });
      return;
    }
    let frame: number | null = null;
    const update = (): void => {
      const next = promptCountdown(window, deadline);
      setCountdown((previous) =>
        previous.remainingMs === next.remainingMs &&
        previous.canRespond === next.canRespond &&
        previous.synchronized === next.synchronized
          ? previous
          : next
      );
      if (next.remainingMs > 0 || !next.synchronized) {
        frame = requestAnimationFrame(update);
      }
    };
    update();
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [window, deadline]);
  return countdown;
}

/**
 * Tiny header control for the in-match sound toggle. Reflects /
 * mutates the persisted `localStorage` flag managed by
 * `~/game/client/sound.ts`.
 *
 * SSR-safe: the initial render uses the default (enabled = true)
 * regardless of `localStorage`, then a one-shot `useEffect` syncs
 * with the actual stored value once mounted. This avoids the
 * hydration-mismatch warning we'd get if `useState`'s initializer
 * touched `localStorage` directly.
 */
import { useEffect, useState } from "react";
import { isGameSoundEnabled, setGameSoundEnabled } from "./sound";

export function MatchSoundToggle(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    setEnabled(isGameSoundEnabled());
  }, []);

  const onClick = (): void => {
    const next = !enabled;
    setGameSoundEnabled(next);
    setEnabled(next);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={enabled ? "Mute game sound" : "Unmute game sound"}
      aria-pressed={enabled}
      className="px-3 py-1.5 rounded bg-emerald-900 hover:bg-emerald-800 text-white text-xs font-semibold transition-colors"
    >
      {enabled ? "🔊 Sound" : "🔇 Muted"}
    </button>
  );
}

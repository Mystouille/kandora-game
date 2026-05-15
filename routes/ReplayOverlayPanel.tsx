import { useState } from "react";

/**
 * Toggle keys for the replay-viewer overlay panel. Each one gates a
 * piece of replay-only HUD rendering layered on top of the Pixi
 * `TableRenderer`:
 *
 *  - `showWaits` — highlight in red every tile (in any pond, hand
 *    or visible wall position) that any player is currently waiting
 *    on, based on the in-flight closed hands.
 *  - `showHands` — reveal opponent hands ("omniscient" mode).
 *    Defaults OFF so the viewer opens "as it was played"; flipping
 *    it on is the Phase 4.5 step 4 toggle (see plan).
 *  - `showWalls` — reveal the live wall + dead wall order.
 *  - `showNames` — render seat names / final scores. Defaults ON;
 *    the only toggle that's on by default.
 */
export interface ReplayOverlayState {
  showWaits: boolean;
  showHands: boolean;
  showWalls: boolean;
  showNames: boolean;
  /** Temporary debug toggle while the Tenhou-style layout is being
   * migrated in. Paints the colored layout regions on top of the
   * canvas so the geometry can be visually verified against the
   * mock. Remove once the migration is complete. */
  showLayoutDebug: boolean;
}

export const defaultReplayOverlayState: ReplayOverlayState = {
  showWaits: false,
  showHands: false,
  showWalls: false,
  showNames: true,
  showLayoutDebug: false,
};

interface ToggleSpec {
  key: keyof ReplayOverlayState;
  label: string;
}

const TOGGLES: ToggleSpec[] = [
  { key: "showWaits", label: "Show waits" },
  { key: "showHands", label: "Show hands" },
  { key: "showWalls", label: "Show walls" },
  { key: "showNames", label: "Show names" },
  { key: "showLayoutDebug", label: "Layout debug" },
];

interface ReplayOverlayPanelProps {
  overlays: ReplayOverlayState;
  onChange: (next: ReplayOverlayState) => void;
}

/**
 * Collapsible left-edge panel for the replay viewer. Defaults
 * closed; clicking the edge tab opens a vertical list of overlay
 * toggles. Active toggles get the accent background; inactive ones
 * stay flat.
 *
 * Stateful only for `open` (cosmetic). Toggle state is lifted to
 * the route so it can be threaded into the renderer when each
 * overlay's actual rendering lands.
 */
export function ReplayOverlayPanel({
  overlays,
  onChange,
}: ReplayOverlayPanelProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);

  const toggle = (key: keyof ReplayOverlayState): void => {
    onChange({ ...overlays, [key]: !overlays[key] });
  };

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 bottom-0 z-20 flex items-center"
      aria-hidden={false}
    >
      {/* Panel + chevron travel together as a single translated
       * unit. When closed, the wrapper is shifted left by the
       * panel's width so the chevron sits flush against the
       * viewport's left edge; opening slides them both back to
       * x = 0. Pointer events on the panel itself are gated on
       * `open` so collapsed-state clicks fall through to the
       * canvas. */}
      <div
        className={`flex items-stretch transition-transform duration-150 ease-out ${
          open ? "translate-x-0" : "-translate-x-48"
        }`}
      >
        <div
          className={`${
            open ? "pointer-events-auto" : "pointer-events-none"
          } w-48 max-h-[80vh] bg-white text-emerald-950 shadow-2xl border-r border-t border-b border-emerald-900/30`}
          role="group"
          aria-label="Replay overlay options"
        >
          <ul className="flex flex-col py-2">
            {TOGGLES.map((t) => {
              const active = overlays[t.key];
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => {
                      toggle(t.key);
                    }}
                    aria-pressed={active}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                      active
                        ? "bg-emerald-700 text-white font-semibold"
                        : "hover:bg-emerald-50 text-emerald-950"
                    }`}
                  >
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          aria-label={open ? "Close overlay panel" : "Open overlay panel"}
          className="pointer-events-auto h-32 w-10 bg-emerald-800 hover:bg-emerald-700 text-white text-3xl font-mono rounded-r border-y border-r border-emerald-900/40 flex items-center justify-center shadow-lg"
        >
          {open ? "‹" : "›"}
        </button>
      </div>
    </div>
  );
}

/**
 * Left-side semi-collapsible options menu for live play.
 *
 * Visual states:
 *   - Expanded: vertical stack of full-text options. Active
 *     options have a highlighted (emerald) background.
 *   - Collapsed: a narrow strip of single-letter buttons
 *     (S / W / C / D). Active options have highlighted text
 *     colour; inactive ones are white.
 *
 * Controlled component: parent owns `flags` (so external
 * signals — e.g. a manual hand drag flipping `autoSort` off
 * — can update the menu). No state is persisted: every fresh
 * page load starts at {@link LIVE_PLAY_MENU_DEFAULTS}.
 */
import { useState } from "react";

/** Stable id → display label (expanded) → single-letter glyph (collapsed). */
const OPTIONS = [
  { key: "autoSort", label: "Auto sort", letter: "S" },
  { key: "autoWin", label: "Auto win", letter: "W" },
  { key: "noCall", label: "No call", letter: "C" },
  { key: "autoDiscard", label: "Auto discard", letter: "D" },
] as const;

export type LivePlayMenuOptionKey = (typeof OPTIONS)[number]["key"];
export type LivePlayMenuFlags = Record<LivePlayMenuOptionKey, boolean>;

export const LIVE_PLAY_MENU_DEFAULTS: LivePlayMenuFlags = {
  autoSort: true,
  autoWin: false,
  noCall: false,
  autoDiscard: false,
};

export interface LivePlayMenuProps {
  /** Controlled flags. Parent should pass the current state. */
  flags: LivePlayMenuFlags;
  /** Fired with the *new* flags whenever a button toggles. */
  onChange: (flags: LivePlayMenuFlags) => void;
}

export function LivePlayMenu(props: LivePlayMenuProps): React.JSX.Element {
  const { flags, onChange } = props;
  const [expanded, setExpanded] = useState<boolean>(false);

  const toggle = (key: LivePlayMenuOptionKey): void => {
    onChange({ ...flags, [key]: !flags[key] });
  };

  // Common handler so right-click (which fires `contextmenu`,
  // not `click`) toggles too — and the native browser context
  // menu is suppressed while hovering the menu.
  const handleContextMenu = (e: React.MouseEvent, action: () => void): void => {
    e.preventDefault();
    action();
  };

  return (
    <div
      // Vertically centred on the left edge. `pointer-events-auto`
      // because the outer match container disables touch
      // gestures on the canvas, not on overlay children.
      className="pointer-events-auto absolute left-2 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-1 rounded-lg border border-emerald-700/60 bg-emerald-950/85 p-1.5 shadow-xl"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onContextMenu={(e) =>
          handleContextMenu(e, () => setExpanded((v) => !v))
        }
        aria-label={expanded ? "Collapse options menu" : "Expand options menu"}
        aria-expanded={expanded}
        className="self-end text-emerald-200 hover:text-white text-2xl font-bold leading-none px-2 py-0.5 rounded hover:bg-emerald-800/60"
      >
        {expanded ? "«" : "»"}
      </button>
      {OPTIONS.map((opt) => {
        const active = flags[opt.key];
        if (expanded) {
          // Expanded row: full label, active = filled bg.
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggle(opt.key)}
              onContextMenu={(e) => handleContextMenu(e, () => toggle(opt.key))}
              aria-pressed={active}
              className={
                "min-w-[120px] text-left px-3 py-1.5 rounded text-sm font-semibold transition-colors " +
                (active
                  ? "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
                  : "bg-emerald-900/70 text-white hover:bg-emerald-800")
              }
            >
              {opt.label}
            </button>
          );
        }
        // Collapsed glyph: text colour reflects state.
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => toggle(opt.key)}
            onContextMenu={(e) => handleContextMenu(e, () => toggle(opt.key))}
            aria-label={`${opt.label} (${active ? "on" : "off"})`}
            aria-pressed={active}
            title={opt.label}
            className={
              "w-7 h-7 flex items-center justify-center rounded font-mono font-bold text-sm transition-colors hover:bg-emerald-800/60 " +
              (active ? "text-emerald-300" : "text-white")
            }
          >
            {opt.letter}
          </button>
        );
      })}
    </div>
  );
}

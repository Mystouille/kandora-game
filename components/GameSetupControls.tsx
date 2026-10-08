import { GameSetupSchema, type GameSetup } from "../rules/gameSetup";
import {
  DUPLICATE_GENERATION_VERSION,
  normalMatchMode,
} from "../protocol/matchMode";
import { SanmaTypeSchema, type PlayerCount } from "../protocol/seat";
import type { SpectatorDelayMs } from "../protocol/spectatorDelay";

export interface GameSetupSelection {
  playerCount: PlayerCount;
  sanmaType: GameSetup["sanmaType"];
  duplicateEnabled: boolean;
  duplicateSeed: string;
}

export const initialGameSetupSelection: GameSetupSelection = {
  playerCount: 4,
  sanmaType: "online",
  duplicateEnabled: false,
  duplicateSeed: "",
};

export function setupPresetId(
  preset: string,
  playerCount: PlayerCount
): string {
  return playerCount === 3 ? "m-league" : preset;
}

export function buildGameSetup(
  preset: string,
  selection: GameSetupSelection,
  spectatorDelayMs: SpectatorDelayMs = 0
): GameSetup {
  const parsed = GameSetupSchema.safeParse({
    preset: setupPresetId(preset, selection.playerCount),
    playerCount: selection.playerCount,
    sanmaType: selection.sanmaType,
    mode: selection.duplicateEnabled
      ? {
          type: "duplicate",
          seed: selection.duplicateSeed,
          generationVersion: DUPLICATE_GENERATION_VERSION,
        }
      : normalMatchMode,
    spectatorDelayMs,
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.some((issue) => issue.path.includes("seed"))
        ? "Enter a duplicate seed between 1 and 128 characters."
        : parsed.error.issues[0].message
    );
  }
  return parsed.data;
}

export function gameVariantLabel(
  variant: Partial<Pick<GameSetup, "playerCount" | "sanmaType">>
): string | null {
  if (variant.playerCount !== 3) {
    return null;
  }
  return `Sanma · ${variant.sanmaType === "kansai" ? "Kansai" : "Online"}`;
}

export function GameSetupControls({
  value,
  onChange,
  disabled = false,
  mobile = false,
}: {
  value: GameSetupSelection;
  onChange: (value: GameSetupSelection) => void;
  disabled?: boolean;
  mobile?: boolean;
}) {
  const fieldClass = mobile
    ? "mobile-spectator-delay"
    : "block text-sm font-medium text-gray-700 dark:text-gray-200";
  const inputClass = mobile
    ? undefined
    : "mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";

  return (
    <fieldset
      aria-label="Game setup"
      disabled={disabled}
      style={{ display: "grid", gap: 12, border: 0, padding: 0, margin: 0 }}
    >
      <div className={mobile ? "rule-options" : "grid gap-3"}>
        <label className={mobile ? undefined : "flex items-center gap-3"}>
          <input
            type="checkbox"
            role="switch"
            checked={value.playerCount === 3}
            onChange={(event) => {
              onChange({ ...value, playerCount: event.target.checked ? 3 : 4 });
            }}
            className="h-5 w-5 accent-emerald-600"
          />
          <span>3-player</span>
        </label>
        <label className={mobile ? undefined : "flex items-center gap-3"}>
          <input
            type="checkbox"
            role="switch"
            checked={value.duplicateEnabled}
            onChange={(event) => {
              onChange({ ...value, duplicateEnabled: event.target.checked });
            }}
            className="h-5 w-5 accent-emerald-600"
          />
          <span>Duplicate mode</span>
        </label>
      </div>
      {value.playerCount === 3 && (
        <label className={fieldClass}>
          <span>Sanma rules · fixed M-League base (no head-bump)</span>
          <select
            name="sanmaType"
            aria-label="Sanma rules"
            value={value.sanmaType}
            className={inputClass}
            onChange={(event) => {
              onChange({
                ...value,
                sanmaType: SanmaTypeSchema.parse(event.target.value),
              });
            }}
          >
            <option value="online">Online</option>
            <option value="kansai">Kansai</option>
          </select>
        </label>
      )}
      {value.duplicateEnabled && (
        <label className={mobile ? "nearby-name-field" : fieldClass}>
          <span>Duplicate seed</span>
          <input
            type="text"
            name="duplicateSeed"
            value={value.duplicateSeed}
            onChange={(event) => {
              onChange({ ...value, duplicateSeed: event.target.value });
            }}
            required
            maxLength={128}
            autoComplete="off"
            placeholder="Enter seed"
            className={inputClass}
          />
        </label>
      )}
    </fieldset>
  );
}

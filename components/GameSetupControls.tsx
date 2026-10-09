import { useId } from "react";
import { GameSetupSchema, type GameSetup } from "../rules/gameSetup";
import {
  DUPLICATE_GENERATION_VERSION,
  normalMatchMode,
} from "../protocol/matchMode";
import { SanmaTypeSchema, type PlayerCount } from "../protocol/seat";
import type { SpectatorDelayMs } from "../protocol/spectatorDelay";
import "./GameSetupControls.css";

export interface GameSetupPreset {
  id: string;
  rulesFamily?: GameSetup["rulesFamily"];
  displayName: string;
  description?: string;
}

export const DEFAULT_GAME_SETUP_PRESET_ID = "m-league";

export interface GameSetupSelection {
  rulesFamily: GameSetup["rulesFamily"];
  playerCount: PlayerCount;
  sanmaType: GameSetup["sanmaType"];
  duplicateEnabled: boolean;
  duplicateSeed: string;
}

export const initialGameSetupSelection: GameSetupSelection = {
  rulesFamily: "riichi",
  playerCount: 4,
  sanmaType: "online",
  duplicateEnabled: false,
  duplicateSeed: "",
};

export function setupPresetId(
  preset: string,
  playerCount: PlayerCount,
  rulesFamily: GameSetup["rulesFamily"] = "riichi"
): string {
  if (rulesFamily === "mcr") {
    return "mcr-ema";
  }
  return playerCount === 3 ? "m-league" : preset;
}

export function buildGameSetup(
  preset: string,
  selection: GameSetupSelection,
  spectatorDelayMs: SpectatorDelayMs = 0
): GameSetup {
  const parsed = GameSetupSchema.safeParse({
    preset: setupPresetId(preset, selection.playerCount, selection.rulesFamily),
    rulesFamily: selection.rulesFamily,
    playerCount: selection.rulesFamily === "mcr" ? 4 : selection.playerCount,
    sanmaType: selection.rulesFamily === "mcr" ? "online" : selection.sanmaType,
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
  variant: Partial<Pick<GameSetup, "rulesFamily" | "playerCount" | "sanmaType">>
): string | null {
  if (variant.rulesFamily === "mcr") {
    return "MCR · EMA Green Book";
  }
  if (variant.playerCount !== 3) {
    return null;
  }
  return `Sanma · ${variant.sanmaType === "kansai" ? "Kansai" : "Online"}`;
}

export function GameSetupControls({
  value,
  onChange,
  presets,
  preset,
  onPresetChange,
  disabled = false,
  mobile = false,
}: {
  value: GameSetupSelection;
  onChange: (value: GameSetupSelection) => void;
  presets: readonly GameSetupPreset[];
  /** Retained Yonma selection, even while Sanma or MCR is active. */
  preset: string;
  onPresetChange: (preset: string) => void;
  disabled?: boolean;
  mobile?: boolean;
}) {
  const controlId = useId();
  const yonmaPresets = presets.filter(
    (entry) => (entry.rulesFamily ?? "riichi") === "riichi"
  );
  const selectedPreset = yonmaPresets.find((entry) => entry.id === preset);

  return (
    <fieldset
      aria-label="Game setup"
      disabled={disabled}
      className={`game-setup-controls${mobile ? " game-setup-controls--mobile" : ""}`}
    >
      <fieldset
        className="game-setup-controls__section"
        aria-label="Mahjong rules"
      >
        <legend>Mahjong rules</legend>
        <div className="game-setup-controls__segments">
          {(["riichi", "mcr"] as const).map((rulesFamily) => (
            <label className="game-setup-controls__option" key={rulesFamily}>
              <input
                type="radio"
                name={`${controlId}-rules-family`}
                value={rulesFamily}
                checked={value.rulesFamily === rulesFamily}
                onChange={() => {
                  onChange({
                    ...value,
                    rulesFamily,
                    ...(rulesFamily === "mcr"
                      ? {
                          playerCount: 4 as const,
                          sanmaType: "online" as const,
                        }
                      : {}),
                  });
                }}
              />
              <span>{rulesFamily === "riichi" ? "Riichi" : "MCR"}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {value.rulesFamily === "riichi" ? (
        <>
          <fieldset
            className="game-setup-controls__section"
            aria-label="Players"
          >
            <legend>Players</legend>
            <div className="game-setup-controls__segments">
              {([4, 3] as const).map((playerCount) => (
                <label
                  className="game-setup-controls__option"
                  key={playerCount}
                >
                  <input
                    type="radio"
                    name={`${controlId}-players`}
                    value={playerCount}
                    checked={value.playerCount === playerCount}
                    onChange={() => {
                      onChange({ ...value, playerCount });
                    }}
                  />
                  <span>
                    {playerCount === 4
                      ? "Yonma (4 players)"
                      : "Sanma (3 players)"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {value.playerCount === 4 ? (
            <label className="game-setup-controls__field">
              <span>Game type</span>
              <select
                name="preset"
                aria-label="Game type"
                aria-describedby={
                  selectedPreset?.description
                    ? `${controlId}-preset-description`
                    : undefined
                }
                value={preset}
                onChange={(event) => {
                  onPresetChange(event.target.value);
                }}
              >
                {yonmaPresets.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName}
                  </option>
                ))}
              </select>
              {selectedPreset?.description && (
                <span
                  id={`${controlId}-preset-description`}
                  className="game-setup-controls__hint"
                >
                  {selectedPreset.description}
                </span>
              )}
            </label>
          ) : (
            <label className="game-setup-controls__field">
              <span>Sanma game type</span>
              <select
                name="sanmaType"
                aria-label="Sanma game type"
                aria-describedby={`${controlId}-sanma-description`}
                value={value.sanmaType}
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
              <span
                id={`${controlId}-sanma-description`}
                className="game-setup-controls__hint"
              >
                Sanma uses a fixed M-League base (no head-bump).
              </span>
            </label>
          )}
        </>
      ) : (
        <p className="game-setup-controls__hint">EMA Green Book · 4 players</p>
      )}
      <fieldset className="game-setup-controls__section game-setup-controls__duplicate">
        <legend>Duplicate</legend>
        <label className="game-setup-controls__switch">
          <input
            type="checkbox"
            role="switch"
            checked={value.duplicateEnabled}
            onChange={(event) => {
              onChange({ ...value, duplicateEnabled: event.target.checked });
            }}
          />
          <span>Duplicate mode</span>
        </label>
        {value.duplicateEnabled && (
          <label className="game-setup-controls__field">
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
            />
          </label>
        )}
      </fieldset>
    </fieldset>
  );
}

import {
  SPECTATOR_DELAY_OPTIONS,
  SpectatorDelayFormValueSchema,
  type SpectatorDelayMs,
} from "~/game/protocol/spectatorDelay";

interface SpectatorDelaySelectProps {
  value: SpectatorDelayMs;
  onChange: (delayMs: SpectatorDelayMs) => void;
  disabled?: boolean;
  className?: string;
}

export function SpectatorDelaySelect({
  value,
  onChange,
  disabled,
  className,
}: SpectatorDelaySelectProps) {
  return (
    <select
      aria-label="Spectator delay"
      name="spectatorDelayMs"
      value={value}
      disabled={disabled}
      className={className}
      onChange={(event) => {
        onChange(
          SpectatorDelayFormValueSchema.parse(event.currentTarget.value)
        );
      }}
    >
      {SPECTATOR_DELAY_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface ReadyCheckTickState {
  deadline: number | null;
  seconds: number;
}

export interface CountdownSoundGateState {
  countdownId: string | null;
  seconds: number;
}

export function advanceCountdownSoundGate(
  previous: CountdownSoundGateState,
  countdownId: string,
  seconds: number
): { play: boolean; next: CountdownSoundGateState } {
  const isNewCountdown = previous.countdownId !== countdownId;
  const isFirstVisibleSecond = previous.seconds < 0;
  const isVisualDecrement = seconds < previous.seconds;
  const play =
    seconds > 0 &&
    (isNewCountdown || isFirstVisibleSecond || isVisualDecrement);
  const trackedSeconds =
    isNewCountdown || isFirstVisibleSecond
      ? seconds
      : Math.min(previous.seconds, seconds);

  return {
    play,
    next: { countdownId, seconds: trackedSeconds },
  };
}

export function resetCountdownSoundGate(): CountdownSoundGateState {
  return { countdownId: null, seconds: -1 };
}

export function resetReadyCheckTick(): ReadyCheckTickState {
  return { deadline: null, seconds: -1 };
}

function trackedReadyCheckSeconds(
  previous: ReadyCheckTickState,
  deadline: number,
  seconds: number
): number {
  if (previous.deadline !== deadline || previous.seconds < 0) {
    return seconds;
  }
  return Math.min(previous.seconds, seconds);
}

export function advanceReadyCheckTick(
  previous: ReadyCheckTickState,
  deadline: number | null,
  seconds: number
): { play: boolean; next: ReadyCheckTickState } {
  if (deadline === null) {
    return {
      play: false,
      next: resetReadyCheckTick(),
    };
  }

  return {
    play:
      seconds > 0 &&
      (previous.deadline !== deadline ||
        previous.seconds < 0 ||
        seconds < previous.seconds),
    next: {
      deadline,
      seconds: trackedReadyCheckSeconds(previous, deadline, seconds),
    },
  };
}

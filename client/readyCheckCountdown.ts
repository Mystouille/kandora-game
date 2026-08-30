export interface ReadyCheckTickState {
  deadline: number | null;
  seconds: number;
}

export function advanceReadyCheckTick(
  previous: ReadyCheckTickState,
  deadline: number | null,
  seconds: number
): { play: boolean; next: ReadyCheckTickState } {
  if (deadline === null) {
    return {
      play: false,
      next: { deadline: null, seconds: -1 },
    };
  }

  return {
    play:
      seconds > 0 &&
      (previous.deadline !== deadline || previous.seconds !== seconds),
    next: { deadline, seconds },
  };
}
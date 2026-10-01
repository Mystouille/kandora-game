import {
  LIVE_AUTOMATED_DRAW_TO_DISCARD_DELAY_MS,
  LIVE_DISCARD_TO_DRAW_DELAY_MS,
} from "~/game/presentationTiming";

import { FIVE_MINUTE_SPECTATOR_DELAY_MS } from "~/game/protocol/spectatorDelay";

let NEXT_HAND_DELAY_MS = 5000;

export function setNextHandDelayMs(ms: number): void {
  NEXT_HAND_DELAY_MS = ms;
}

let CONTINUE_VOTE_MS = 30_000;

export function setContinueVoteMs(ms: number): void {
  CONTINUE_VOTE_MS = ms;
}

let MATCH_END_DISPLAY_MS = 3000;

export function setMatchEndDisplayMs(ms: number): void {
  MATCH_END_DISPLAY_MS = ms;
}

let DELAY_AFTER_DISCARD_MS = LIVE_DISCARD_TO_DRAW_DELAY_MS;

let DRAW_TO_DISCARD_DELAY_MS = LIVE_AUTOMATED_DRAW_TO_DISCARD_DELAY_MS;

let WIN_REACTION_DELAY_MS = 350 + 700;

export function remainingWinReactionDelayMs(
  triggerEmittedAt: number,
  now: number,
  minimumAgeMs: number = WIN_REACTION_DELAY_MS
): number {
  return Math.max(0, minimumAgeMs - Math.max(0, now - triggerEmittedAt));
}

let WIN_TO_PANEL_DELAY_MS = 500;

let EXHAUSTIVE_DRAW_DELAY_MS = 1_000;

export function setExhaustiveDrawDelayMs(ms: number): void {
  EXHAUSTIVE_DRAW_DELAY_MS = ms;
}

let RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS = 700;

let RYUUKYOKU_DECLARATION_ACTION_MS = 5_000;

let RYUUKYOKU_RESULT_DELAY_MS = 1_000;

export function setRyuukyokuDeclarationTimingMs(opts: {
  automatic?: number;
  action?: number;
  result?: number;
}): void {
  if (opts.automatic !== undefined) {
    RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS = opts.automatic;
  }
  if (opts.action !== undefined) {
    RYUUKYOKU_DECLARATION_ACTION_MS = opts.action;
  }
  if (opts.result !== undefined) {
    RYUUKYOKU_RESULT_DELAY_MS = opts.result;
  }
}

const WIN_YAKU_REVEAL_INTERVAL_MS = 750;

const WIN_URA_REVEAL_AFTER_LAST_YAKU_MS = 2000;

const WIN_SCORE_REVEAL_WITHOUT_URA_MS = 750;

export function winResultRevealDurationMs(args: {
  visibleYakuCount: number;
  hasUraYaku: boolean;
  uraDoraEnabled?: boolean;
}): number {
  const regularYakuCount = Math.max(
    0,
    args.visibleYakuCount - (args.hasUraYaku ? 1 : 0)
  );
  const lastRegularYakuRevealAtMs =
    regularYakuCount * WIN_YAKU_REVEAL_INTERVAL_MS;
  return (args.uraDoraEnabled ?? true)
    ? lastRegularYakuRevealAtMs + WIN_URA_REVEAL_AFTER_LAST_YAKU_MS
    : lastRegularYakuRevealAtMs + WIN_SCORE_REVEAL_WITHOUT_URA_MS;
}

export function setDelayAfterDiscardMs(ms: number): void {
  DELAY_AFTER_DISCARD_MS = ms;
  DRAW_TO_DISCARD_DELAY_MS = ms;
  WIN_REACTION_DELAY_MS = ms;
  WIN_TO_PANEL_DELAY_MS = ms;
  EXHAUSTIVE_DRAW_DELAY_MS = ms;
  RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS = ms;
  RYUUKYOKU_RESULT_DELAY_MS = ms;
}

let BASE_ACTION_MS = 5_000;

let ACTION_GRACE_MS = 200;

let INITIAL_BUFFER_MS = 20_000;

const TENHOU_RELAY_VIEWER_DELAY_MS = FIVE_MINUTE_SPECTATOR_DELAY_MS;

let READY_CHECK_MS = 0;

export function setReadyCheckMs(ms: number): void {
  READY_CHECK_MS = ms;
}

export function setActionTimeoutMs(ms: number): void {
  BASE_ACTION_MS = ms;
  ACTION_GRACE_MS = 0;
  INITIAL_BUFFER_MS = 0;
}

export function setActionTimingMs(opts: {
  base?: number;
  grace?: number;
  buffer?: number;
}): void {
  if (opts.base !== undefined) {
    BASE_ACTION_MS = opts.base;
  }
  if (opts.grace !== undefined) {
    ACTION_GRACE_MS = opts.grace;
  }
  if (opts.buffer !== undefined) {
    INITIAL_BUFFER_MS = opts.buffer;
  }
}

export const legacyTiming = {
  get NEXT_HAND_DELAY_MS(): typeof NEXT_HAND_DELAY_MS {
    return NEXT_HAND_DELAY_MS;
  },

  get CONTINUE_VOTE_MS(): typeof CONTINUE_VOTE_MS {
    return CONTINUE_VOTE_MS;
  },

  get MATCH_END_DISPLAY_MS(): typeof MATCH_END_DISPLAY_MS {
    return MATCH_END_DISPLAY_MS;
  },

  get DELAY_AFTER_DISCARD_MS(): typeof DELAY_AFTER_DISCARD_MS {
    return DELAY_AFTER_DISCARD_MS;
  },

  get DRAW_TO_DISCARD_DELAY_MS(): typeof DRAW_TO_DISCARD_DELAY_MS {
    return DRAW_TO_DISCARD_DELAY_MS;
  },

  get WIN_REACTION_DELAY_MS(): typeof WIN_REACTION_DELAY_MS {
    return WIN_REACTION_DELAY_MS;
  },

  get WIN_TO_PANEL_DELAY_MS(): typeof WIN_TO_PANEL_DELAY_MS {
    return WIN_TO_PANEL_DELAY_MS;
  },

  get EXHAUSTIVE_DRAW_DELAY_MS(): typeof EXHAUSTIVE_DRAW_DELAY_MS {
    return EXHAUSTIVE_DRAW_DELAY_MS;
  },

  get RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS(): typeof RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS {
    return RYUUKYOKU_AUTOMATIC_DECLARATION_DELAY_MS;
  },

  get RYUUKYOKU_DECLARATION_ACTION_MS(): typeof RYUUKYOKU_DECLARATION_ACTION_MS {
    return RYUUKYOKU_DECLARATION_ACTION_MS;
  },

  get RYUUKYOKU_RESULT_DELAY_MS(): typeof RYUUKYOKU_RESULT_DELAY_MS {
    return RYUUKYOKU_RESULT_DELAY_MS;
  },

  get BASE_ACTION_MS(): typeof BASE_ACTION_MS {
    return BASE_ACTION_MS;
  },

  get ACTION_GRACE_MS(): typeof ACTION_GRACE_MS {
    return ACTION_GRACE_MS;
  },

  get INITIAL_BUFFER_MS(): typeof INITIAL_BUFFER_MS {
    return INITIAL_BUFFER_MS;
  },

  get READY_CHECK_MS(): typeof READY_CHECK_MS {
    return READY_CHECK_MS;
  },

  get TENHOU_RELAY_VIEWER_DELAY_MS(): typeof TENHOU_RELAY_VIEWER_DELAY_MS {
    return TENHOU_RELAY_VIEWER_DELAY_MS;
  },
};

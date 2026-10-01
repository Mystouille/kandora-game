import { z } from "zod";
import { MatchModeConfigSchema } from "~/game/protocol/matchMode";
import { SpectatorDelayMsSchema } from "~/game/protocol/spectatorDelay";
import {
  ActionWindowViewSchema,
  PromptTimingSnapshotSchema,
} from "~/game/protocol/timing";
import {
  GameEventSchema,
  LegalActionSchema,
  MatchDebugSchema,
  TileSchema,
} from "~/game/protocol/messages";
import { MatchStateSchema } from "~/game/rules/state";
import { RuleSetSchema } from "~/game/rules/ruleSet";

export const MATCH_CHECKPOINT_SCHEMA_VERSION = 7 as const;

const DecisionTimingCheckpointSchema = z
  .object({
    nextWindow: z.number().int().positive(),
    prompts: PromptTimingSnapshotSchema.optional(),
    windows: z.tuple([
      ActionWindowViewSchema.nullable(),
      ActionWindowViewSchema.nullable(),
      ActionWindowViewSchema.nullable(),
      ActionWindowViewSchema.nullable(),
    ]),
  })
  .strict()
  .superRefine((timing, context) => {
    timing.windows.forEach((window, seat) => {
      if (!window) {
        return;
      }
      if (
        window.seat !== seat ||
        window.kind === "ready" ||
        window.kind === "session_vote"
      ) {
        context.addIssue({
          code: "custom",
          path: ["windows", seat],
          message: "Action-window seat or kind is inconsistent",
        });
      }
    });
  });

const CheckpointPlayerSchema = z
  .object({
    userId: z.string().min(1),
    displayName: z.string(),
    isBot: z.boolean(),
  })
  .strict();

const NumberTuple4Schema = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
]);
const NonnegativeNumberTuple4Schema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const BooleanTuple4Schema = z.tuple([
  z.boolean(),
  z.boolean(),
  z.boolean(),
  z.boolean(),
]);
const SeatSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const DuplicateHandKeySchema = z
  .object({
    gameIndex: z.number().int().nonnegative(),
    roundWind: z.enum(["E", "S", "W", "N"]),
    roundNumber: z.number().int().positive(),
    honba: z.number().int().nonnegative(),
    dealer: SeatSchema,
  })
  .strict();

export const MatchDriverSnapshotSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("normal") }).strict(),
  z
    .object({
      type: z.literal("duplicate"),
      activeHand: z
        .object({
          key: DuplicateHandKeySchema,
          cursors: z.tuple([
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
            z.number().int().nonnegative(),
          ]),
        })
        .strict()
        .nullable(),
    })
    .strict(),
]);

export const WaitingRoomCheckpointSchema = z
  .object({
    schemaVersion: z.literal(MATCH_CHECKPOINT_SCHEMA_VERSION),
    status: z.literal("waiting"),
    savedAt: z.number().int().nonnegative(),
    matchId: z.string().min(1),
    seed: z.number().int(),
    presetId: z.string().min(1),
    spectatorDelayMs: SpectatorDelayMsSchema.default(0),
    decisionTiming: DecisionTimingCheckpointSchema,
    mode: MatchModeConfigSchema,
    driver: MatchDriverSnapshotSchema,
    ruleSet: RuleSetSchema,
    debug: MatchDebugSchema,
    seats: z.tuple([
      CheckpointPlayerSchema.nullable(),
      CheckpointPlayerSchema.nullable(),
      CheckpointPlayerSchema.nullable(),
      CheckpointPlayerSchema.nullable(),
    ]),
    ready: BooleanTuple4Schema.default([false, false, false, false]),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const humanIds = new Set<string>();
    for (const [seat, player] of checkpoint.seats.entries()) {
      if (player === null || player.isBot) {
        continue;
      }
      if (humanIds.has(player.userId)) {
        context.addIssue({
          code: "custom",
          path: ["seats", seat, "userId"],
          message: "Human user IDs must be unique within a room",
        });
      }
      humanIds.add(player.userId);
    }
  });

export type WaitingRoomCheckpoint = z.infer<typeof WaitingRoomCheckpointSchema>;

const PlayingCheckpointBaseShape = {
  schemaVersion: z.literal(MATCH_CHECKPOINT_SCHEMA_VERSION),
  status: z.literal("playing"),
  savedAt: z.number().int().nonnegative(),
  matchId: z.string().min(1),
  seed: z.number().int(),
  presetId: z.string().min(1),
  spectatorDelayMs: SpectatorDelayMsSchema.default(0),
  decisionTiming: DecisionTimingCheckpointSchema,
  mode: MatchModeConfigSchema,
  driver: MatchDriverSnapshotSchema,
  seats: z.tuple([
    CheckpointPlayerSchema,
    CheckpointPlayerSchema,
    CheckpointPlayerSchema,
    CheckpointPlayerSchema,
  ]),
  state: MatchStateSchema,
  startedAgoMs: z.number().int().nonnegative(),
  startedCalendarAt: z.number().int().nonnegative().optional(),
  randomState: z.number().int().min(0).max(0xffffffff),
  eventLog: z.array(
    z
      .object({
        seq: z.number().int().nonnegative(),
        event: GameEventSchema,
        emittedAgoMs: z.number().int().nonnegative(),
        calendarAt: z.number().int().nonnegative().optional(),
      })
      .strict()
  ),
  nextSeq: z.number().int().nonnegative(),
  seatSeq: NonnegativeNumberTuple4Schema,
  spectatorSeq: z.number().int().nonnegative(),
  handStartLiveWall: z.array(TileSchema).nullable(),
  gameStartLogIdx: z.number().int().nonnegative(),
  gameIndex: z.number().int().nonnegative(),
  sessionChips: NumberTuple4Schema,
  gameStartChips: NumberTuple4Schema,
  sessionDabuken: BooleanTuple4Schema,
  dice: z.tuple([
    z.number().int().min(1).max(6),
    z.number().int().min(1).max(6),
  ]),
  riichiTileIdx: z.tuple([
    z.number().int().nonnegative().nullable(),
    z.number().int().nonnegative().nullable(),
    z.number().int().nonnegative().nullable(),
    z.number().int().nonnegative().nullable(),
  ]),
  humanDrawQueue: z.array(TileSchema),
  leftDiscardQueue: z.array(TileSchema),
  bufferMs: NonnegativeNumberTuple4Schema,
  connectionPolicy: z
    .object({
      disconnected: BooleanTuple4Schema,
      afkSelfReported: BooleanTuple4Schema,
      livenessProbeMisses: NonnegativeNumberTuple4Schema,
    })
    .strict(),
  lastEngineEventType: z
    .enum([
      "draw",
      "discard",
      "ryuukyoku_declaration",
      "win",
      "hand_end",
      "buu_chombo",
      "call",
      "new_dora",
      "hand_start",
      "match_end",
    ])
    .nullable(),
} as const;

const CallOptionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chi"),
      tiles: z.tuple([TileSchema, TileSchema]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pon"),
      tiles: z.tuple([TileSchema, TileSchema]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("daiminkan"),
      tiles: z.tuple([TileSchema, TileSchema, TileSchema]),
    })
    .strict(),
  z.object({ kind: z.literal("ron") }).strict(),
]);

const CallOptionsSlotSchema = z.array(CallOptionSchema).min(1).nullable();
const CallTimerSlotSchema = z
  .object({
    legalActions: z.array(LegalActionSchema).min(1),
    elapsedMs: z.number().int().nonnegative(),
    visibleRemainingMs: z.number().int().nonnegative(),
    expiryRemainingMs: z.number().int().nonnegative(),
  })
  .strict()
  .nullable();

export const PlayingActionCheckpointSchema = z
  .object({
    ...PlayingCheckpointBaseShape,
    checkpointKind: z.literal("action_window"),
    actionWindow: z
      .object({
        kind: z.enum(["turn", "ryuukyoku_declaration"]).default("turn"),
        seat: SeatSchema,
        legalActions: z.array(LegalActionSchema).min(1),
        elapsedMs: z.number().int().nonnegative(),
        visibleRemainingMs: z.number().int().nonnegative(),
        expiryRemainingMs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const { kind, seat, legalActions } = checkpoint.actionWindow;
    const expectedPhase =
      kind === "ryuukyoku_declaration"
        ? "awaiting_ryuukyoku_declarations"
        : "awaiting_discard";
    if (checkpoint.state.phase !== expectedPhase) {
      context.addIssue({
        code: "custom",
        path: ["state", "phase"],
        message: `${kind} action-window checkpoints require ${expectedPhase}`,
      });
    }
    if (checkpoint.state.turn !== seat) {
      context.addIssue({
        code: "custom",
        path: ["actionWindow", "seat"],
        message: "Action-window seat must match the authoritative turn",
      });
    }
    if (checkpoint.seats[seat].isBot) {
      context.addIssue({
        code: "custom",
        path: ["seats", seat, "isBot"],
        message: "Action-window seat must be human",
      });
    }
    if (kind === "turn") {
      if (!legalActions.some((action) => action.type === "discard")) {
        context.addIssue({
          code: "custom",
          path: ["actionWindow", "legalActions"],
          message: "Own-turn action window must include a discard",
        });
      }
    } else {
      const types = new Set(legalActions.map((action) => action.type));
      if (
        legalActions.length !== 2 ||
        !types.has("declare_tenpai") ||
        !types.has("declare_noten")
      ) {
        context.addIssue({
          code: "custom",
          path: ["actionWindow", "legalActions"],
          message: "Ryuukyoku declaration window must contain Tenpai and Noten",
        });
      }
    }
    if (checkpoint.gameStartLogIdx > checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["gameStartLogIdx"],
        message: "Game log start cannot exceed the event log length",
      });
    }
    if (checkpoint.nextSeq !== checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["nextSeq"],
        message: "Next sequence must equal the contiguous event log length",
      });
    }
    checkpoint.eventLog.forEach((entry, index) => {
      if (entry.seq !== index) {
        context.addIssue({
          code: "custom",
          path: ["eventLog", index, "seq"],
          message: "Event log sequence must be contiguous from zero",
        });
      }
    });
  });

export type PlayingActionCheckpoint = z.infer<
  typeof PlayingActionCheckpointSchema
>;

export const PlayingCallCheckpointSchema = z
  .object({
    ...PlayingCheckpointBaseShape,
    checkpointKind: z.literal("call_window"),
    callWindows: z.tuple([
      CallOptionsSlotSchema,
      CallOptionsSlotSchema,
      CallOptionsSlotSchema,
      CallOptionsSlotSchema,
    ]),
    pendingHumanCallActions: z.tuple([
      LegalActionSchema.nullable(),
      LegalActionSchema.nullable(),
      LegalActionSchema.nullable(),
      LegalActionSchema.nullable(),
    ]),
    pendingBotRons: z.array(SeatSchema),
    pendingBotCalls: z.array(
      z.object({ seat: SeatSchema, option: CallOptionSchema }).strict()
    ),
    pendingChankanBotRons: z.array(SeatSchema),
    callTimers: z.tuple([
      CallTimerSlotSchema,
      CallTimerSlotSchema,
      CallTimerSlotSchema,
      CallTimerSlotSchema,
    ]),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.state.phase !== "awaiting_draw" &&
      checkpoint.state.phase !== "awaiting_chankan"
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "phase"],
        message: "Call checkpoints require awaiting_draw or awaiting_chankan",
      });
    }
    if (
      checkpoint.state.phase === "awaiting_draw" &&
      checkpoint.state.lastDiscard === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "lastDiscard"],
        message: "Discard call window requires a last discard",
      });
    }
    if (
      checkpoint.state.phase === "awaiting_chankan" &&
      checkpoint.state.pendingShouminkan === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["state", "pendingShouminkan"],
        message: "Chankan window requires a pending shouminkan",
      });
    }
    if (
      checkpoint.state.phase === "awaiting_draw" &&
      checkpoint.pendingChankanBotRons.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingChankanBotRons"],
        message: "Discard call window cannot carry chankan candidates",
      });
    }
    if (
      checkpoint.state.phase === "awaiting_chankan" &&
      (checkpoint.pendingBotRons.length > 0 ||
        checkpoint.pendingBotCalls.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingBotRons"],
        message: "Chankan window cannot carry ordinary discard-call intents",
      });
    }
    let openCount = 0;
    for (let seat = 0; seat < 4; seat++) {
      const options = checkpoint.callWindows[seat];
      const timer = checkpoint.callTimers[seat];
      const pending = checkpoint.pendingHumanCallActions[seat];
      if (options !== null) {
        openCount += 1;
        if (checkpoint.seats[seat].isBot) {
          context.addIssue({
            code: "custom",
            path: ["seats", seat, "isBot"],
            message: "Open call window seat must be human",
          });
        }
        if (timer === null) {
          context.addIssue({
            code: "custom",
            path: ["callTimers", seat],
            message: "Open call window requires an active timer",
          });
        } else if (
          !timer.legalActions.some((action) => action.type === "pass")
        ) {
          context.addIssue({
            code: "custom",
            path: ["callTimers", seat, "legalActions"],
            message: "Open call window must include pass",
          });
        }
        if (pending !== null) {
          context.addIssue({
            code: "custom",
            path: ["pendingHumanCallActions", seat],
            message: "Open call window cannot already have a response",
          });
        }
      } else if (timer !== null) {
        context.addIssue({
          code: "custom",
          path: ["callTimers", seat],
          message: "Closed call window cannot retain a timer",
        });
      }
    }
    if (openCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["callWindows"],
        message: "Call checkpoint requires at least one open window",
      });
    }
    if (checkpoint.gameStartLogIdx > checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["gameStartLogIdx"],
        message: "Game log start cannot exceed the event log length",
      });
    }
    if (checkpoint.nextSeq !== checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["nextSeq"],
        message: "Next sequence must equal the contiguous event log length",
      });
    }
    checkpoint.eventLog.forEach((entry, index) => {
      if (entry.seq !== index) {
        context.addIssue({
          code: "custom",
          path: ["eventLog", index, "seq"],
          message: "Event log sequence must be contiguous from zero",
        });
      }
    });
  });

export type PlayingCallCheckpoint = z.infer<typeof PlayingCallCheckpointSchema>;

export const PlayingReadyCheckpointSchema = z
  .object({
    ...PlayingCheckpointBaseShape,
    checkpointKind: z.literal("ready_check"),
    readyContinuation: z.enum(["initial_hand", "next_hand"]),
    readyAcked: BooleanTuple4Schema,
    readyRemainingMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const expectedPhase =
      checkpoint.readyContinuation === "initial_hand"
        ? "awaiting_draw"
        : "hand_ended";
    if (checkpoint.state.phase !== expectedPhase) {
      context.addIssue({
        code: "custom",
        path: ["state", "phase"],
        message: `${checkpoint.readyContinuation} ready check requires ${expectedPhase}`,
      });
    }
    checkpoint.seats.forEach((player, seat) => {
      if (player.isBot && !checkpoint.readyAcked[seat]) {
        context.addIssue({
          code: "custom",
          path: ["readyAcked", seat],
          message: "Bot seats must already be ready",
        });
      }
    });
    if (checkpoint.gameStartLogIdx > checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["gameStartLogIdx"],
        message: "Game log start cannot exceed the event log length",
      });
    }
    if (checkpoint.nextSeq !== checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["nextSeq"],
        message: "Next sequence must equal the contiguous event log length",
      });
    }
    checkpoint.eventLog.forEach((entry, index) => {
      if (entry.seq !== index) {
        context.addIssue({
          code: "custom",
          path: ["eventLog", index, "seq"],
          message: "Event log sequence must be contiguous from zero",
        });
      }
    });
  });

export type PlayingReadyCheckpoint = z.infer<
  typeof PlayingReadyCheckpointSchema
>;

const FinalScoreSchema = z
  .object({
    seat: SeatSchema,
    score: z.number().int(),
    place: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  })
  .strict();

export const PlayingContinueVoteCheckpointSchema = z
  .object({
    ...PlayingCheckpointBaseShape,
    checkpointKind: z.literal("continue_vote"),
    votes: z.tuple([
      z.enum(["yes", "no"]).nullable(),
      z.enum(["yes", "no"]).nullable(),
      z.enum(["yes", "no"]).nullable(),
      z.enum(["yes", "no"]).nullable(),
    ]),
    voteRemainingMs: z.number().int().nonnegative(),
    timeoutArmed: z.boolean(),
    finalScores: z.tuple([
      FinalScoreSchema,
      FinalScoreSchema,
      FinalScoreSchema,
      FinalScoreSchema,
    ]),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (!checkpoint.state.ruleSet.buuMode) {
      context.addIssue({
        code: "custom",
        path: ["state", "ruleSet", "buuMode"],
        message: "Continue-vote checkpoint requires Buu mode",
      });
    }
    if (checkpoint.state.phase !== "match_ended") {
      context.addIssue({
        code: "custom",
        path: ["state", "phase"],
        message: "Continue-vote checkpoint requires match_ended",
      });
    }
    const resolutionPending =
      checkpoint.votes.some((vote) => vote === "no") ||
      checkpoint.votes.every((vote) => vote === "yes");
    if (resolutionPending && checkpoint.timeoutArmed) {
      context.addIssue({
        code: "custom",
        path: ["timeoutArmed"],
        message: "Resolved continue vote cannot retain an armed timeout",
      });
    }
    checkpoint.seats.forEach((player, seat) => {
      if (player.isBot && checkpoint.votes[seat] !== "yes") {
        context.addIssue({
          code: "custom",
          path: ["votes", seat],
          message: "Bot seats must pre-vote yes",
        });
      }
    });
    const seats = new Set(checkpoint.finalScores.map((score) => score.seat));
    const places = new Set(checkpoint.finalScores.map((score) => score.place));
    if (seats.size !== 4 || places.size !== 4) {
      context.addIssue({
        code: "custom",
        path: ["finalScores"],
        message: "Final standings must contain every seat and place once",
      });
    }
    if (checkpoint.gameStartLogIdx > checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["gameStartLogIdx"],
        message: "Game log start cannot exceed the event log length",
      });
    }
    if (checkpoint.nextSeq !== checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["nextSeq"],
        message: "Next sequence must equal the contiguous event log length",
      });
    }
  });

export type PlayingContinueVoteCheckpoint = z.infer<
  typeof PlayingContinueVoteCheckpointSchema
>;

export const PlayingResultTransitionCheckpointSchema = z
  .object({
    ...PlayingCheckpointBaseShape,
    checkpointKind: z.literal("result_transition"),
    transitionKind: z.literal("post_hand_reveal"),
    transitionRemainingMs: z.number().int().nonnegative(),
    nextReadyMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.state.phase !== "hand_ended") {
      context.addIssue({
        code: "custom",
        path: ["state", "phase"],
        message: "Post-hand reveal transition requires hand_ended",
      });
    }
    if (checkpoint.state.lastHandResult === null) {
      context.addIssue({
        code: "custom",
        path: ["state", "lastHandResult"],
        message: "Post-hand reveal transition requires a hand result",
      });
    }
    if (checkpoint.gameStartLogIdx > checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["gameStartLogIdx"],
        message: "Game log start cannot exceed the event log length",
      });
    }
    if (checkpoint.nextSeq !== checkpoint.eventLog.length) {
      context.addIssue({
        code: "custom",
        path: ["nextSeq"],
        message: "Next sequence must equal the contiguous event log length",
      });
    }
  });

export type PlayingResultTransitionCheckpoint = z.infer<
  typeof PlayingResultTransitionCheckpointSchema
>;
function checkpointRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function migratedWindow(
  checkpoint: Record<string, unknown>,
  seat: number,
  kind: "turn" | "call" | "ryuukyoku_declaration",
  stored: Record<string, unknown>
): unknown {
  const savedAt = nonnegativeInteger(checkpoint.savedAt);
  const elapsedMs = nonnegativeInteger(stored.elapsedMs);
  const visibleRemainingMs = nonnegativeInteger(stored.visibleRemainingMs);
  const expiryRemainingMs = nonnegativeInteger(stored.expiryRemainingMs);
  const baseRemainingMs = Math.min(visibleRemainingMs, expiryRemainingMs);
  const baseEndsAt = savedAt + baseRemainingMs;
  const expiresAt = savedAt + expiryRemainingMs;
  const legalActions = Array.isArray(stored.legalActions)
    ? stored.legalActions
    : [];
  const legalActionIds = legalActions.flatMap((action) => {
    const record = checkpointRecord(action);
    return typeof record?.id === "string" ? [record.id] : [];
  });
  const matchId =
    typeof checkpoint.matchId === "string" ? checkpoint.matchId : "match";
  return {
    id: `${matchId}:${seat}:migrated`,
    clockEpoch: `checkpoint-${matchId}`,
    timingVersion: 2,
    seat,
    kind,
    state: "open",
    infoSentAt: Math.max(0, savedAt - elapsedMs),
    opensAt: Math.max(0, savedAt - elapsedMs),
    baseEndsAt,
    budgetEndsAt: expiresAt,
    expiresAt,
    bankAtOpenMs: expiresAt - baseEndsAt,
    allowanceMs: 0,
    generation: 0,
    legalActionIds,
  };
}

function migratedDecisionTiming(
  checkpoint: Record<string, unknown>
): Record<string, unknown> {
  const existing = checkpointRecord(checkpoint.decisionTiming);
  if (existing !== null) {
    const { mode: _removedMode, ...timing } = existing;
    return timing;
  }

  const windows: unknown[] = [null, null, null, null];
  if (checkpoint.checkpointKind === "action_window") {
    const actionWindow = checkpointRecord(checkpoint.actionWindow);
    const seat = nonnegativeInteger(actionWindow?.seat);
    if (actionWindow !== null && seat < windows.length) {
      const kind =
        actionWindow.kind === "ryuukyoku_declaration"
          ? "ryuukyoku_declaration"
          : "turn";
      windows[seat] = migratedWindow(checkpoint, seat, kind, actionWindow);
    }
  } else if (
    checkpoint.checkpointKind === "call_window" &&
    Array.isArray(checkpoint.callTimers)
  ) {
    checkpoint.callTimers.forEach((timer, seat) => {
      const stored = checkpointRecord(timer);
      if (stored !== null && seat < windows.length) {
        windows[seat] = migratedWindow(checkpoint, seat, "call", stored);
      }
    });
  }
  return { nextWindow: 1, windows };
}

function migrateLegacyCheckpoint(input: unknown): unknown {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("schemaVersion" in input)
  ) {
    return input;
  }
  if (
    input.schemaVersion !== 1 &&
    input.schemaVersion !== 2 &&
    input.schemaVersion !== 3 &&
    input.schemaVersion !== 4 &&
    input.schemaVersion !== 5 &&
    input.schemaVersion !== 6
  ) {
    return input;
  }
  const migrated = {
    ...input,
    schemaVersion: MATCH_CHECKPOINT_SCHEMA_VERSION,
    ...(input.schemaVersion === 1
      ? { mode: { type: "normal" }, driver: { type: "normal" } }
      : {}),
  };
  return {
    ...migrated,
    decisionTiming: migratedDecisionTiming(migrated),
  };
}

export const MatchCheckpointSchema = z.preprocess(
  migrateLegacyCheckpoint,
  z.union([
    WaitingRoomCheckpointSchema,
    PlayingActionCheckpointSchema,
    PlayingCallCheckpointSchema,
    PlayingReadyCheckpointSchema,
    PlayingContinueVoteCheckpointSchema,
    PlayingResultTransitionCheckpointSchema,
  ])
);
export type MatchCheckpoint = z.infer<typeof MatchCheckpointSchema>;

export function parseMatchCheckpoint(input: unknown): MatchCheckpoint {
  return MatchCheckpointSchema.parse(input);
}

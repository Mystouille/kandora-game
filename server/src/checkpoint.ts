import { z } from "zod";
import {
  GameEventSchema,
  LegalActionSchema,
  MatchDebugSchema,
  TileSchema,
} from "~/game/protocol/messages";
import { MatchStateSchema, RuleSetSchema } from "~/game/rules";

export const MATCH_CHECKPOINT_SCHEMA_VERSION = 1 as const;

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

export const WaitingRoomCheckpointSchema = z
  .object({
    schemaVersion: z.literal(MATCH_CHECKPOINT_SCHEMA_VERSION),
    status: z.literal("waiting"),
    savedAt: z.number().int().nonnegative(),
    matchId: z.string().min(1),
    seed: z.number().int(),
    presetId: z.string().min(1),
    ruleSet: RuleSetSchema,
    debug: MatchDebugSchema,
    seats: z.tuple([
      CheckpointPlayerSchema.nullable(),
      CheckpointPlayerSchema.nullable(),
      CheckpointPlayerSchema.nullable(),
      CheckpointPlayerSchema.nullable(),
    ]),
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

export type WaitingRoomCheckpoint = z.infer<
  typeof WaitingRoomCheckpointSchema
>;

const PlayingCheckpointBaseShape = {
  schemaVersion: z.literal(MATCH_CHECKPOINT_SCHEMA_VERSION),
  status: z.literal("playing"),
  savedAt: z.number().int().nonnegative(),
  matchId: z.string().min(1),
  seed: z.number().int(),
  presetId: z.string().min(1),
  seats: z.tuple([
    CheckpointPlayerSchema,
    CheckpointPlayerSchema,
    CheckpointPlayerSchema,
    CheckpointPlayerSchema,
  ]),
  state: MatchStateSchema,
  startedAgoMs: z.number().int().nonnegative(),
  randomState: z.number().int().min(0).max(0xffffffff),
  eventLog: z.array(
    z
      .object({
        seq: z.number().int().nonnegative(),
        event: GameEventSchema,
        emittedAgoMs: z.number().int().nonnegative(),
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
  lastEngineEventType: z
    .enum([
      "draw",
      "discard",
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
    const { seat, legalActions } = checkpoint.actionWindow;
    if (checkpoint.state.phase !== "awaiting_discard") {
      context.addIssue({
        code: "custom",
        path: ["state", "phase"],
        message: "Action-window checkpoints require awaiting_discard",
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
    if (!legalActions.some((action) => action.type === "discard")) {
      context.addIssue({
        code: "custom",
        path: ["actionWindow", "legalActions"],
        message: "Own-turn action window must include a discard",
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
      z
        .object({ seat: SeatSchema, option: CallOptionSchema })
        .strict()
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
        } else if (!timer.legalActions.some((action) => action.type === "pass")) {
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

export type PlayingCallCheckpoint = z.infer<
  typeof PlayingCallCheckpointSchema
>;

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
    if (checkpoint.readyAcked.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["readyAcked"],
        message: "Ready checkpoint requires at least one pending human",
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
    if (checkpoint.votes.every((vote) => vote !== null)) {
      context.addIssue({
        code: "custom",
        path: ["votes"],
        message: "Open continue vote requires a pending seat",
      });
    }
    if (checkpoint.votes.some((vote) => vote === "no")) {
      context.addIssue({
        code: "custom",
        path: ["votes"],
        message: "A no vote must resolve immediately",
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
export const MatchCheckpointSchema = z.union([
  WaitingRoomCheckpointSchema,
  PlayingActionCheckpointSchema,
  PlayingCallCheckpointSchema,
  PlayingReadyCheckpointSchema,
  PlayingContinueVoteCheckpointSchema,
]);
export type MatchCheckpoint = z.infer<typeof MatchCheckpointSchema>;

export function parseMatchCheckpoint(input: unknown): MatchCheckpoint {
  return MatchCheckpointSchema.parse(input);
}
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

export const PlayingActionCheckpointSchema = z
  .object({
    schemaVersion: z.literal(MATCH_CHECKPOINT_SCHEMA_VERSION),
    status: z.literal("playing"),
    checkpointKind: z.literal("action_window"),
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
export const MatchCheckpointSchema = z.union([
  WaitingRoomCheckpointSchema,
  PlayingActionCheckpointSchema,
]);
export type MatchCheckpoint = z.infer<typeof MatchCheckpointSchema>;

export function parseMatchCheckpoint(input: unknown): MatchCheckpoint {
  return MatchCheckpointSchema.parse(input);
}
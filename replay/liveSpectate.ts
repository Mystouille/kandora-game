import { cloneDuplicateWallState } from "~/game/duplicate/duplicateWallState";
import type {
  GameEvent,
  ServerMessage,
  SnapshotState,
} from "~/game/protocol/messages";
import { applyReplayEvent, initialView, type ReplayView } from "./player";
import { copySeatValues, seatValues } from "~/game/rules/seats";
import { snapshotInitialDeadWall } from "~/game/client/variantState";

export interface LiveSpectateTimeline {
  baseline: ReplayView | null;
  events: GameEvent[];
  lastSeq: number;
}

type LiveSpectateMessage = Extract<
  ServerMessage,
  { type: "snapshot" | "event" }
>;

export function createLiveSpectateTimeline(): LiveSpectateTimeline {
  return { baseline: null, events: [], lastSeq: -1 };
}

export function snapshotToReplayView(snapshot: SnapshotState): ReplayView {
  const base = initialView(snapshot);
  return {
    ...base,
    hands: snapshot.hands.map((hand) => [...hand]),
    melds: snapshot.melds.map((melds) => [...melds]),
    discards: snapshot.discards.map((discards) => [...discards]),
    discardTsumogiri: snapshot.discards.map((discards, seat) =>
      discards.map(
        (_, index) => snapshot.discardTsumogiri?.[seat]?.[index] ?? false
      )
    ),
    discardSources: snapshot.discards.map((discards) =>
      discards.map(() => null)
    ),
    discardOrdinals: snapshot.discards.map((discards) =>
      discards.map((_, index) => index)
    ),
    totalDiscards: snapshot.discards.reduce(
      (total, discards) => total + discards.length,
      0
    ),
    wallRemaining: snapshot.wallRemaining,
    nukiTiles: seatValues(snapshot.playerCount ?? 4, (seat) => [
      ...(snapshot.nukiTiles?.[seat] ?? []),
    ]),
    pendingNuki: snapshot.pendingNuki ? { ...snapshot.pendingNuki } : null,
    sanmaWall: snapshot.sanmaWall ? { ...snapshot.sanmaWall } : null,
    turn: snapshot.turn,
    phase: snapshot.phase,
    drawsTaken:
      snapshot.drawsTaken ??
      (snapshot.playerCount === 3 ? 0 : 70 - snapshot.wallRemaining),
    liveWall: snapshot.liveWall ? [...snapshot.liveWall] : null,
    deadWall: snapshotInitialDeadWall(snapshot),
    liveDrawsTaken: snapshot.liveDrawsTaken ?? 0,
    duplicateWallState: snapshot.duplicateWallState
      ? cloneDuplicateWallState(snapshot.duplicateWallState)
      : null,
    duplicateDrawQueues: null,
    doraIndicators: [...snapshot.doraIndicators],
    scores: copySeatValues(snapshot.scores),
    dealer: snapshot.dealer,
    roundWind: snapshot.roundWind,
    roundNumber: snapshot.roundNumber,
    honba: snapshot.honba,
    riichiSticks: snapshot.riichiSticks,
    riichiDeclared: copySeatValues(snapshot.riichiDeclared),
    ryuukyokuDeclarations: snapshot.ryuukyokuDeclarations
      ? copySeatValues(snapshot.ryuukyokuDeclarations)
      : base.ryuukyokuDeclarations,
    ryuukyokuTenpaiHands: seatValues(snapshot.playerCount ?? 4, (seat) => {
      const hand = snapshot.ryuukyokuTenpaiHands?.[seat];
      return hand ? [...hand] : null;
    }),
    lastHandResult: snapshot.lastHandResult
      ? { ...structuredClone(snapshot.lastHandResult), dealer: snapshot.dealer }
      : null,
    riichiTileIdx: snapshot.riichiTileIdx
      ? copySeatValues(snapshot.riichiTileIdx)
      : base.riichiTileIdx,
    dice: snapshot.dice ?? null,
    furiten: snapshot.furiten ? copySeatValues(snapshot.furiten) : base.furiten,
    sinking: snapshot.sinking ? copySeatValues(snapshot.sinking) : base.sinking,
    chips: snapshot.chips ? copySeatValues(snapshot.chips) : base.chips,
    dabuken: snapshot.dabuken ? copySeatValues(snapshot.dabuken) : base.dabuken,
    buuMode: snapshot.chips !== undefined,
    scoreCap: snapshot.scoreCap ?? null,
    riichiBetValue: snapshot.riichiBetValue ?? base.riichiBetValue,
    uraDoraEnabled: snapshot.uraDoraEnabled ?? true,
    freshlyDrawnSeat: snapshot.freshlyDrawnSeat ?? null,
  };
}

export function advanceLiveSpectateTimeline(
  current: LiveSpectateTimeline,
  message: LiveSpectateMessage
): LiveSpectateTimeline {
  if (message.type === "snapshot") {
    return {
      baseline: snapshotToReplayView(message.state),
      events: [],
      lastSeq: message.seq,
    };
  }
  if (message.events.length === 0 || message.seq <= current.lastSeq) {
    return current;
  }

  const startSeq = message.seq - message.events.length + 1;
  if (
    current.baseline === null &&
    startSeq === 0 &&
    message.events.length > 1
  ) {
    let baseline = initialView();
    for (const event of message.events) {
      baseline = applyReplayEvent(baseline, event);
    }
    return { baseline, events: [], lastSeq: message.seq };
  }

  const unseenOffset = Math.max(0, current.lastSeq - startSeq + 1);
  const incoming = message.events.slice(unseenOffset);
  if (incoming.length === 0) {
    return current;
  }
  return {
    baseline: current.baseline ?? initialView(),
    events: [...current.events, ...incoming],
    lastSeq: message.seq,
  };
}

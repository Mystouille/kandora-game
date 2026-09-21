import { cloneDuplicateWallState } from "~/game/duplicate/duplicateWallState";
import type {
  GameEvent,
  ServerMessage,
  SnapshotState,
} from "~/game/protocol/messages";
import { applyReplayEvent, initialView, type ReplayView } from "./player";

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
  const base = initialView();
  return {
    ...base,
    hands: snapshot.hands.map((hand) => [...hand]),
    melds: snapshot.melds.map((melds) => [...melds]),
    discards: snapshot.discards.map((discards) => [...discards]),
    discardTsumogiri: snapshot.discards.map((discards) =>
      discards.map(() => false)
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
    drawsTaken: snapshot.drawsTaken ?? 70 - snapshot.wallRemaining,
    liveWall: snapshot.liveWall ? [...snapshot.liveWall] : null,
    liveDrawsTaken: snapshot.liveDrawsTaken ?? 0,
    duplicateWallState: snapshot.duplicateWallState
      ? cloneDuplicateWallState(snapshot.duplicateWallState)
      : null,
    duplicateDrawQueues: null,
    doraIndicators: [...snapshot.doraIndicators],
    scores: [
      snapshot.scores[0],
      snapshot.scores[1],
      snapshot.scores[2],
      snapshot.scores[3],
    ],
    dealer: snapshot.dealer,
    roundWind: snapshot.roundWind,
    roundNumber: snapshot.roundNumber,
    honba: snapshot.honba,
    riichiSticks: snapshot.riichiSticks,
    riichiDeclared: [
      snapshot.riichiDeclared[0],
      snapshot.riichiDeclared[1],
      snapshot.riichiDeclared[2],
      snapshot.riichiDeclared[3],
    ],
    riichiTileIdx: snapshot.riichiTileIdx
      ? [
          snapshot.riichiTileIdx[0],
          snapshot.riichiTileIdx[1],
          snapshot.riichiTileIdx[2],
          snapshot.riichiTileIdx[3],
        ]
      : [null, null, null, null],
    dice: snapshot.dice ?? null,
    furiten: snapshot.furiten
      ? [
          snapshot.furiten[0],
          snapshot.furiten[1],
          snapshot.furiten[2],
          snapshot.furiten[3],
        ]
      : [false, false, false, false],
    sinking: snapshot.sinking
      ? [
          snapshot.sinking[0],
          snapshot.sinking[1],
          snapshot.sinking[2],
          snapshot.sinking[3],
        ]
      : [false, false, false, false],
    chips: snapshot.chips
      ? [
          snapshot.chips[0],
          snapshot.chips[1],
          snapshot.chips[2],
          snapshot.chips[3],
        ]
      : [0, 0, 0, 0],
    dabuken: snapshot.dabuken
      ? [
          snapshot.dabuken[0],
          snapshot.dabuken[1],
          snapshot.dabuken[2],
          snapshot.dabuken[3],
        ]
      : [false, false, false, false],
    buuMode: snapshot.chips !== undefined,
    scoreCap: snapshot.scoreCap ?? null,
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
  if (current.baseline === null && startSeq === 0 && message.events.length > 1) {
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
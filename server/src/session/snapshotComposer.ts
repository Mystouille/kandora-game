import type { GameEvent, Seat, ServerMessage } from "~/game/protocol/messages";
import { type Tile } from "~/game/rules";
import { projectEvent } from "../projection";

import type { MatchStateView, MatchKernel } from "./matchKernel";
import type { MatchPlayerInit } from "./roomRoster";
import type { HandMetadata } from "./handMetadata";
import type { ActionWindowRegistry } from "../timing/actionWindows";
import type { TimeBank } from "../timing/timeBank";
import type { DecisionTiming } from "../timing/decisionTiming";
import type { DuplicateWallState } from "~/game/protocol/messages";

export interface SnapshotComposerPort {
  state(): MatchStateView;
  history(): readonly { seq: number; event: GameEvent; emittedAt: number }[];
  players(): ReadonlyMap<Seat, MatchPlayerInit | null>;
  seatSequences(): readonly number[];
  spectatorSequence(): number;
  handStartWall(): readonly Tile[] | null;
  duplicateWallEventFields(): { duplicateWallState?: DuplicateWallState };
  computeSinking(): [boolean, boolean, boolean, boolean];
  sessionVote?(): import("~/game/protocol/messages").SnapshotState["sessionVote"];
  readonly kernel: Pick<MatchKernel, "isFuriten">;
  readonly metadata: Pick<HandMetadata, "snapshot">;
  readonly windows: Pick<ActionWindowRegistry, "view" | "legals">;
  readonly bank: Pick<TimeBank, "balance">;
  readonly timing: Pick<DecisionTiming, "metadata">;
}

function discardTsumogiriFromHistory(
  history: readonly { event: GameEvent }[]
): boolean[][] {
  let tiles: Tile[][] = [[], [], [], []];
  let flags: boolean[][] = [[], [], [], []];

  for (const { event } of history) {
    if (event.type === "match_start" || event.type === "hand_start") {
      tiles = [[], [], [], []];
      flags = [[], [], [], []];
      continue;
    }
    if (event.type === "discard") {
      tiles[event.seat].push(event.tile);
      flags[event.seat].push(event.tsumogiri);
      continue;
    }
    if (
      event.type === "call" &&
      event.meld.from !== null &&
      event.meld.claimedTile !== null
    ) {
      const from = event.meld.from;
      const index = tiles[from].lastIndexOf(event.meld.claimedTile);
      if (index >= 0) {
        tiles[from].splice(index, 1);
        flags[from].splice(index, 1);
      }
    }
  }

  return flags;
}

export class SnapshotComposer {
  constructor(private readonly port: SnapshotComposerPort) {}
  ryuukyokuPublicState(): {
    declarations: [
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
    ];
    tenpaiHands: [Tile[] | null, Tile[] | null, Tile[] | null, Tile[] | null];
  } | null {
    const pending = this.port.state().pendingRyuukyoku;
    if (pending !== null) {
      const declarations = [...pending.declarations] as [
        boolean | null,
        boolean | null,
        boolean | null,
        boolean | null,
      ];
      const tenpaiHands = declarations.map((declaration, seat) =>
        declaration === true ? [...this.port.state().hands[seat]] : null
      ) as [Tile[] | null, Tile[] | null, Tile[] | null, Tile[] | null];
      return { declarations, tenpaiHands };
    }
    const settled = this.settledRyuukyokuResult();
    if (
      settled?.declarations === undefined ||
      settled.tenpaiHands === undefined
    ) {
      return null;
    }
    const declarations = settled.declarations.reduce<
      [boolean | null, boolean | null, boolean | null, boolean | null]
    >(
      (bySeat, declaration) => {
        bySeat[declaration.seat] = declaration.tenpai;
        return bySeat;
      },
      [null, null, null, null]
    );
    const tenpaiHands = settled.tenpaiHands.map((hand) =>
      hand ? [...hand] : null
    ) as [Tile[] | null, Tile[] | null, Tile[] | null, Tile[] | null];
    return { declarations, tenpaiHands };
  }

  settledRyuukyokuResult(): Extract<GameEvent, { type: "hand_end" }> | null {
    let handEndIndex = -1;
    for (let index = this.port.history().length - 1; index >= 0; index--) {
      const event = this.port.history()[index].event;
      if (event.type === "hand_start" || event.type === "match_start") {
        break;
      }
      if (event.type === "hand_end" && event.reason === "exhaustive_draw") {
        handEndIndex = index;
        break;
      }
    }
    if (handEndIndex < 0) {
      return null;
    }
    const handEnd = this.port.history()[handEndIndex].event;
    if (handEnd.type !== "hand_end" || handEnd.reason !== "exhaustive_draw") {
      return null;
    }
    const declarations: Array<{ seat: Seat; tenpai: boolean }> = [];
    for (let index = handEndIndex - 1; index >= 0; index--) {
      const event = this.port.history()[index].event;
      if (event.type === "hand_start" || event.type === "match_start") {
        break;
      }
      if (event.type === "ryuukyoku_declaration") {
        declarations.unshift({ seat: event.seat, tenpai: event.tenpai });
      }
    }
    if (
      declarations.length !== 4 ||
      handEnd.tenpai === undefined ||
      handEnd.tenpaiHands === undefined
    ) {
      return null;
    }
    return {
      ...handEnd,
      declarations,
    };
  }

  projectForSeat(event: GameEvent, recipient: Seat): GameEvent | null {
    const projected = projectEvent(event, recipient);
    if (projected === null) {
      return null;
    }
    if (projected.type === "hand_start") {
      return { ...projected, hand: [...this.port.state().hands[recipient]] };
    }
    return projected;
  }

  buildSnapshotForSeat(
    seat: Seat
  ): Extract<ServerMessage, { type: "snapshot" }> {
    const ryuukyoku = this.ryuukyokuPublicState();
    const lastHandResult = this.settledRyuukyokuResult();
    const sessionVote = this.port.sessionVote?.();
    const discardTsumogiri = discardTsumogiriFromHistory(this.port.history());
    return {
      ...this.port.timing.metadata(seat, this.port.seatSequences()[seat] - 1),
      type: "snapshot",
      seq: this.port.seatSequences()[seat] - 1,
      state: {
        mySeat: seat,
        hands: this.port
          .state()
          .hands.map((h, s) =>
            s === seat || (ryuukyoku?.tenpaiHands[s] ?? null) !== null
              ? [...h]
              : new Array<Tile | null>(h.length).fill(null)
          ),
        discards: this.port.state().discards.map((d) => [...d]),
          discardTsumogiri,
          melds: this.port.state().melds.map((mlds) =>
          mlds.map((m) => ({
            type: m.type,
            tiles: [...m.tiles],
            claimedTile: m.claimedTile,
            from: m.from,
          }))
        ),
        wallRemaining: this.port.state().liveWall.length,
        ...this.port.duplicateWallEventFields(),
        // Number of post-deal draws this hand. A normal draw removes
        // one live-wall tile; a rinshan draw reserves the back tile
        // into the dead wall, so both shrink `liveWall` by one.
        drawsTaken: 70 - this.port.state().liveWall.length,
        doraIndicators: [...this.port.state().doraIndicators],
        turn: this.port.state().turn,
        freshlyDrawnSeat:
          this.port.state().phase === "awaiting_discard" &&
          this.port.state().lastDrawn[this.port.state().turn] !== null
            ? this.port.state().turn
            : null,
        dealer: this.port.state().dealer,
        roundWind: this.port.state().roundWind,
        roundNumber: this.port.state().roundNumber,
        honba: this.port.state().honba,
        riichiSticks: this.port.state().riichiSticks,
        scores: [...this.port.state().scores],
        sinking: this.port.computeSinking(),
        riichiBetValue: this.port.state().ruleSet.riichiBetValue,
        uraDoraEnabled: this.port.state().ruleSet.uraDora,
        ...(this.port.state().ruleSet.scoreCap
          ? { scoreCap: this.port.state().ruleSet.scoreCap }
          : {}),
        ...(this.port.state().ruleSet.buuMode
          ? {
              chips: [...this.port.state().chips] as [
                number,
                number,
                number,
                number,
              ],
              dabuken: [...this.port.state().dabuken] as [
                boolean,
                boolean,
                boolean,
                boolean,
              ],
            }
          : {}),
        riichiDeclared: [...this.port.state().riichiDeclared],
        riichiTileIdx: [...this.port.metadata.snapshot().riichiTileIdx] as [
          number | null,
          number | null,
          number | null,
          number | null,
        ],
        lastDiscard: this.port.state().lastDiscard,
        phase: this.port.state().phase,
        ...(ryuukyoku
          ? {
              ryuukyokuDeclarations: ryuukyoku.declarations,
              ryuukyokuTenpaiHands: ryuukyoku.tenpaiHands,
            }
          : {}),
        ...(lastHandResult ? { lastHandResult } : {}),
        ...(sessionVote !== undefined ? { sessionVote } : {}),
        dice: [
          this.port.metadata.snapshot().dice[0],
          this.port.metadata.snapshot().dice[1],
        ],
        // Furiten is private; the snapshot only carries the
        // recipient's own status. Opponent slots are always
        // `false` from this seat's perspective (their real value
        // is never sent over the wire).
        furiten: [0, 1, 2, 3].map((s) =>
          s === seat ? this.port.kernel.isFuriten(seat) : false
        ) as [boolean, boolean, boolean, boolean],
        // Per-seat display names so a reconnecting human or a
        // mid-match spectator sees the correct HUD labels without
        // having to wait for the next `match_start` (which only
        // fires once at the very start of the match).
        seatNames: [0, 1, 2, 3].map(
          (s) => this.port.players().get(s as Seat)?.displayName ?? ""
        ) as [string, string, string, string],
      },
      // Legals/deadline are per-seat (slice 2): each open window
      // has its own timer and option set; this projection surfaces
      // only the recipient's own.
      legalActions: this.port.windows.legals(seat),
      ...(this.port.windows.view(seat).deadline !== null
        ? { deadline: this.port.windows.view(seat).deadline as number }
        : {}),
      ...(this.port.windows.view(seat).kind === "ryuukyoku_declaration"
        ? {}
        : { bufferMs: this.port.bank.balance(seat) }),
    };
  }

  buildSpectatorSnapshot(): ServerMessage {
    const startingWall = this.port.handStartWall();
    const ryuukyoku = this.ryuukyokuPublicState();
    const lastHandResult = this.settledRyuukyokuResult();
    const discardTsumogiri = discardTsumogiriFromHistory(this.port.history());
    return {
      type: "snapshot",
      // `spectatorSeq` is the next seq to assign; `seq - 1` is the
      // last seq emitted. Clamp to 0 when no projected events have
      // happened yet (e.g. snapshot taken before `match_start`).
      seq: Math.max(0, this.port.spectatorSequence() - 1),
      state: {
        mySeat: null,
        // Spectators are omniscient: every seat's full hand is
        // visible.
        hands: this.port.state().hands.map((h) => [...h]),
        discards: this.port.state().discards.map((d) => [...d]),
        discardTsumogiri,
        melds: this.port.state().melds.map((mlds) =>
          mlds.map((m) => ({
            type: m.type,
            tiles: [...m.tiles],
            claimedTile: m.claimedTile,
            from: m.from,
          }))
        ),
        wallRemaining: this.port.state().liveWall.length,
        ...this.port.duplicateWallEventFields(),
        drawsTaken: 70 - this.port.state().liveWall.length,
        doraIndicators: [...this.port.state().doraIndicators],
        turn: this.port.state().turn,
        freshlyDrawnSeat:
          this.port.state().phase === "awaiting_discard" &&
          this.port.state().lastDrawn[this.port.state().turn] !== null
            ? this.port.state().turn
            : null,
        dealer: this.port.state().dealer,
        roundWind: this.port.state().roundWind,
        roundNumber: this.port.state().roundNumber,
        honba: this.port.state().honba,
        riichiSticks: this.port.state().riichiSticks,
        scores: [...this.port.state().scores],
        sinking: this.port.computeSinking(),
        riichiBetValue: this.port.state().ruleSet.riichiBetValue,
        uraDoraEnabled: this.port.state().ruleSet.uraDora,
        ...(this.port.state().ruleSet.scoreCap
          ? { scoreCap: this.port.state().ruleSet.scoreCap }
          : {}),
        ...(this.port.state().ruleSet.buuMode
          ? {
              chips: [...this.port.state().chips] as [
                number,
                number,
                number,
                number,
              ],
              dabuken: [...this.port.state().dabuken] as [
                boolean,
                boolean,
                boolean,
                boolean,
              ],
            }
          : {}),
        riichiDeclared: [...this.port.state().riichiDeclared],
        riichiTileIdx: [...this.port.metadata.snapshot().riichiTileIdx] as [
          number | null,
          number | null,
          number | null,
          number | null,
        ],
        lastDiscard: this.port.state().lastDiscard,
        phase: this.port.state().phase,
        ...(ryuukyoku
          ? {
              ryuukyokuDeclarations: ryuukyoku.declarations,
              ryuukyokuTenpaiHands: ryuukyoku.tenpaiHands,
            }
          : {}),
        ...(lastHandResult ? { lastHandResult } : {}),
        dice: [
          this.port.metadata.snapshot().dice[0],
          this.port.metadata.snapshot().dice[1],
        ],
        // Spectators see the live per-seat furiten state (union
        // of permanent / locked + temporary flags).
        furiten: [0, 1, 2, 3].map(
          (s) =>
            this.port.state().furitenLocked[s] ||
            this.port.state().furitenTemp[s]
        ) as [boolean, boolean, boolean, boolean],
        // Per-seat display names so a spectator joining mid-match
        // sees the correct HUD labels without waiting for the
        // next `match_start` (which only fires once per match).
        seatNames: [0, 1, 2, 3].map(
          (s) => this.port.players().get(s as Seat)?.displayName ?? ""
        ) as [string, string, string, string],
        // Omniscient starting wall for the current hand, plus the
        // number of live-wall draws taken since the hand began.
        // Together these power the `showWalls` overlay for
        // spectators who join mid-hand — the renderer uses
        // `liveDrawsTaken` to hide positions that have already
        // been drawn off the wall. `null` before the first
        // `hand_start` of the match (handled as "no wall data").
        ...(startingWall
          ? {
              liveWall: [...startingWall],
              liveDrawsTaken: Math.max(
                0,
                startingWall.length - this.port.state().liveWall.length
              ),
            }
          : {}),
      },
      legalActions: [],
    };
  }
}

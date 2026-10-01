import {
  riichiLibYakuToRomaji,
  type EngineEvent,
  type FuritenChange,
  type Tile,
} from "~/game/rules";
import { legacyTiming, winResultRevealDurationMs } from "./legacyPolicy";

import type { MatchStateView } from "./matchKernel";
import type { HandMetadata } from "./handMetadata";
import type { HandLifecycle } from "./handLifecycle";
import type { EndMatchOptions } from "./sessionTypes";
import type { TimeBank } from "../timing/timeBank";
import type { TransitionKind } from "./transitionBarrier";
import type { DuplicateWallState, GameEvent } from "~/game/protocol/messages";
export interface EngineEventPort {
  state(): MatchStateView;
  readonly metadata: Pick<
    HandMetadata,
    "resetRiichiTiles" | "recordRiichiTile"
  >;
  readonly hand: Pick<HandLifecycle, "recordWinReveal" | "pendingRevealMs">;
  readonly bank: Pick<TimeBank, "refill">;
  emitEvent(event: GameEvent): Promise<void>;
  waitForEventAge(
    trigger: "draw" | "discard" | "call",
    age: number,
    transition: TransitionKind
  ): Promise<void>;
  runReadyCheck(ms: number): Promise<void>;
  runUncheckpointableTransition(
    kind: TransitionKind,
    delay: number
  ): Promise<void>;
  duplicateWallEventFields(): { duplicateWallState?: DuplicateWallState };
  computeSinking(): [boolean, boolean, boolean, boolean];
  rollDice(): [number, number];
  endMatch(
    reason: "exhaustive_draw" | "ron" | "tsumo" | "abort",
    options: EndMatchOptions
  ): Promise<void>;
}

export class EngineEventPresenter {
  private lastEngineEventType: EngineEvent["type"] | null = null;
  get lastType(): EngineEvent["type"] | null {
    return this.lastEngineEventType;
  }
  restoreLastType(type: EngineEvent["type"] | null): void {
    this.lastEngineEventType = type;
  }

  constructor(private readonly port: EngineEventPort) {}
  async emitFuritenChanges(
    changes: readonly FuritenChange[] | undefined
  ): Promise<void> {
    if (!changes) {
      return;
    }
    for (const c of changes) {
      await this.port.emitEvent({
        type: "furiten",
        seat: c.seat,
        active: c.active,
      });
    }
  }

  async emitEngineEvent(e: EngineEvent): Promise<void> {
    if (e.type === "hand_end" && e.reason === "exhaustive_draw") {
      await this.port.waitForEventAge(
        "discard",
        legacyTiming.EXHAUSTIVE_DRAW_DELAY_MS,
        "exhaustive_draw_reaction"
      );
    }
    // Chombo-by-winning: the engine emits `win` then
    // `buu_chombo` in the same step batch (see `applyWin` in
    // `app/game/rules/step.ts`). Pause between them so the
    // client renders the win-info panel for its normal
    // display duration before the chombo screen takes over.
    if (
      e.type === "buu_chombo" &&
      this.lastEngineEventType === "win" &&
      legacyTiming.NEXT_HAND_DELAY_MS > 0
    ) {
      await this.port.runReadyCheck(legacyTiming.NEXT_HAND_DELAY_MS);
    }
    // Pause between the `win` event (which makes the client flip
    // the winner's concealed hand face-up at the seat band) and
    // the `hand_end` event (which pops up the central win-info
    // panel). Without this, the panel can occlude the flipped
    // hand before the audience registers what was declared.
    if (
      e.type === "hand_end" &&
      this.lastEngineEventType === "win" &&
      legacyTiming.WIN_TO_PANEL_DELAY_MS > 0
    ) {
      await this.port.runUncheckpointableTransition(
        "win_to_panel",
        legacyTiming.WIN_TO_PANEL_DELAY_MS
      );
    }
    this.lastEngineEventType = e.type;
    if (e.type === "draw") {
      await this.port.emitEvent({
        type: "draw",
        seat: e.seat,
        tile: e.tile,
        wallRemaining: e.wallRemaining,
        ...(e.fromDeadWall ? { fromDeadWall: true as const } : {}),
        ...this.port.duplicateWallEventFields(),
      });
      return;
    }
    if (e.type === "discard") {
      await this.port.emitEvent({
        type: "discard",
        seat: e.seat,
        tile: e.tile,
        tsumogiri: e.tsumogiri,
        discardSource: e.discardSource,
        ...(e.riichi ? { riichi: true as const } : {}),
        ...this.port.duplicateWallEventFields(),
      });
      if (e.riichi) {
        // Record the discard pile index where this seat's riichi
        // declaration tile landed, so snapshots can mark it as
        // rotated even after a rejoin.
        this.port.metadata.recordRiichiTile(
          e.seat,
          this.port.state().discards[e.seat].length - 1
        );
        // The engine already deducted `riichiBetValue` from
        // `state.scores[seat]` when the riichi action stepped,
        // so the declarer may have just crossed the sink
        // threshold. Refresh the client view in Buu mode.
        if (this.port.state().ruleSet.buuMode) {
          await this.port.emitEvent({
            type: "sinking_update",
            sinking: this.port.computeSinking(),
          });
        }
      }
      return;
    }
    if (e.type === "ryuukyoku_declaration") {
      await this.port.emitEvent({
        type: "ryuukyoku_declaration",
        seat: e.seat,
        tenpai: e.tenpai,
        ...(e.tenpai ? { hand: [...this.port.state().hands[e.seat]] } : {}),
      });
      return;
    }
    if (e.type === "win") {
      const score = e.score;
      const yakuRomaji = riichiLibYakuToRomaji(score.yaku);
      // Compute this winner's staged-reveal duration so the
      // post-hand ready check (in `afterHandEnd`) can wait for
      // the client animation to finish before starting the OK
      // countdown. Mirrors the visibility logic in
      // `TableRenderer.renderResultCenterInfo`: filter out
      // 0-han yaku, schedule each remaining yaku at a 750ms
      // beat, then wait +2000ms before revealing any Ura Dora and
      // the han/fu, hand value, and score deltas together.
      const uraDoraEnabled = this.port.state().ruleSet.uraDora;
      const hasUraIndicators =
        uraDoraEnabled && this.port.state().riichiDeclared[e.winner];
      let visibleYakuCount = 0;
      let hasUraYaku = false;
      for (const [name, value] of Object.entries(yakuRomaji)) {
        if (!uraDoraEnabled && name === "Ura Dora") {
          continue;
        }
        const leading = parseInt(value, 10);
        if (Number.isFinite(leading) && leading === 0) {
          continue;
        }
        visibleYakuCount += 1;
        if (name === "Ura Dora") {
          hasUraYaku = true;
        }
      }
      const revealMs = winResultRevealDurationMs({
        visibleYakuCount,
        hasUraYaku,
        uraDoraEnabled,
      });
      if (revealMs > this.port.hand.pendingRevealMs) {
        this.port.hand.recordWinReveal(revealMs);
      }
      await this.port.emitEvent({
        type: "win",
        seat: e.winner,
        loser: e.loser,
        winTile: e.winTile,
        delta: e.delta,
        han: score.han,
        fu: score.fu,
        ten: score.ten,
        yakumanCount: score.yakumanCount,
        yaku: yakuRomaji,
        doraCount: score.doraCount,
        akaDoraCount: score.akaDoraCount,
        ...(hasUraIndicators ? { uraDoraCount: score.uraDoraCount } : {}),
        hand: [...this.port.state().hands[e.winner]],
        melds: this.port.state().melds[e.winner].map((m) => ({
          type: m.type,
          tiles: [...m.tiles],
          claimedTile: m.claimedTile,
          from: m.from,
        })),
        doraIndicators: [...this.port.state().doraIndicators],
        uraDoraIndicators: hasUraIndicators
          ? [...this.port.state().uraDoraIndicators]
          : undefined,
      });
      return;
    }
    if (e.type === "hand_end") {
      const r = this.port.state().lastHandResult;
      // At exhaustive draw, reveal the concealed hand of each
      // tenpai seat so the post-hand panel can show what each
      // tenpai player was waiting on. Non-tenpai seats stay
      // null; other reasons skip this entirely (winners are
      // handled by per-seat `win` events).
      //
      // Kyuushuu kyuuhai is the one abort that also reveals a hand:
      // just the declaring seat's, so opponents and spectators see
      // the ≥9 terminals/honors that justified the abort. The engine
      // keeps `turn` pinned to the declarer through the abort.
      const tenpaiHands =
        e.reason === "exhaustive_draw" && r?.tenpai
          ? (r.tenpai.map((t, s) =>
              t ? [...this.port.state().hands[s]] : null
            ) as (Tile[] | null)[])
          : e.reason === "abort" && e.abortKind === "kyuushuu"
            ? ([0, 1, 2, 3].map((s) =>
                s === this.port.state().turn
                  ? [...this.port.state().hands[s]]
                  : null
              ) as (Tile[] | null)[])
            : undefined;
      await this.port.emitEvent({
        type: "hand_end",
        reason: e.reason,
        ...(e.abortKind ? { abortKind: e.abortKind } : {}),
        delta: e.delta,
        ...(r?.tenpai ? { tenpai: [...r.tenpai] } : {}),
        ...(r?.nagashi ? { nagashi: [...r.nagashi] } : {}),
        scores: [...this.port.state().scores] as [
          number,
          number,
          number,
          number,
        ],
        honba: this.port.state().honba,
        riichiSticks: this.port.state().riichiSticks,
        ...(tenpaiHands ? { tenpaiHands } : {}),
        ...(e.chipDelta ? { chipDelta: e.chipDelta } : {}),
        ...(e.sinkingCount !== undefined
          ? { sinkingCount: e.sinkingCount }
          : {}),
        ...(e.dabukenConsumed !== undefined
          ? { dabukenConsumed: e.dabukenConsumed }
          : {}),
        ...(e.dabukenAwarded !== undefined
          ? { dabukenAwarded: e.dabukenAwarded }
          : {}),
        // Buu: ship the absolute chips/dabuken totals so the
        // client's player-nameplate chip counters + dabuken
        // tokens refresh immediately on hand_end (matching the
        // engine state) instead of waiting for the next
        // hand_start / match_start. Skipped for non-Buu rule sets.
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
      });
      return;
    }
    if (e.type === "buu_chombo") {
      await this.port.emitEvent({
        type: "buu_chombo",
        seat: e.seat,
        reason: e.reason,
        chipDelta: e.chipDelta,
        chips: e.chips,
      });
      return;
    }
    if (e.type === "call") {
      const replacementDrawFollowsImmediately =
        (e.meld.type === "ankan" || e.meld.type === "daiminkan") &&
        this.port.state().lastDrawFromDeadWall;
      await this.port.emitEvent({
        type: "call",
        seat: e.seat,
        meld: e.meld,
        ...(replacementDrawFollowsImmediately
          ? {}
          : this.port.duplicateWallEventFields()),
      });
      return;
    }
    if (e.type === "new_dora") {
      await this.port.emitEvent({ type: "new_dora", indicator: e.indicator });
      return;
    }
    if (e.type === "hand_start") {
      this.port.metadata.resetRiichiTiles();
      // Refill each seat's per-hand think buffer.
      this.port.bank.refill(legacyTiming.INITIAL_BUFFER_MS);
      await this.port.emitEvent({
        type: "hand_start",
        round:
          (e.roundWind === "E"
            ? 0
            : e.roundWind === "S"
              ? 1
              : e.roundWind === "W"
                ? 2
                : 3) *
            4 +
          (e.roundNumber - 1),
        dealer: e.dealer,
        roundWind: e.roundWind,
        roundNumber: e.roundNumber,
        honba: e.honba,
        riichiSticks: this.port.state().riichiSticks,
        scores: [...this.port.state().scores] as [
          number,
          number,
          number,
          number,
        ],
        sinking: this.port.computeSinking(),
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
        doraIndicators: [...e.doraIndicators],
        dice: this.port.rollDice(),
        ...this.port.duplicateWallEventFields(),
      });
      return;
    }
    if (e.type === "match_end") {
      // Defer wire emission to endMatch (so we don't double-emit).
      await this.port.endMatch(
        this.port.state().lastHandResult?.reason ?? "exhaustive_draw",
        {
          skipHandEnd: true,
          finalScores: e.finalScores,
          matchEndReason: e.reason,
        }
      );
      return;
    }
  }
}

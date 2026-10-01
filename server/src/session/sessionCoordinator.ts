import type { Seat } from "~/game/protocol/messages";

import type { MatchEndReason } from "~/game/rules";

import type { MatchRuntime } from "../runtime";

import type { MatchRepository, PersistedMatchPlayer } from "../repository";

import { MatchKernel } from "./matchKernel";

import { RoomRoster } from "./roomRoster";

import type { MatchConfiguration, FinalScore } from "./sessionTypes";

import type { SessionLifecyclePort } from "./lifecyclePorts";

import { legacyTiming } from "./legacyPolicy";

import { deterministicShuffle } from "./seating";

export interface SessionSnapshot {
  readonly status: "waiting" | "playing" | "finished";
  readonly startedAt: Date | null;
  readonly finalized: boolean;
  readonly gameIndex: number;
  readonly gameStartLogIdx: number;
  readonly sessionChips: [number, number, number, number];
  readonly gameStartChips: [number, number, number, number];
  readonly sessionDabuken: [boolean, boolean, boolean, boolean];
  readonly sessionFinalized: boolean;
  readonly pendingSessionEndReason:
    "vote_no" | "vote_timeout" | "single_game" | "server_abort" | null;
}

export class SessionCoordinator {
  private statusValue: "waiting" | "playing" | "finished" = "waiting";
  private startedAt: Date | null = null;
  private finalized = false;
  private gameIndex = 0;
  private gameStartLogIdx = 0;
  private sessionChips: [number, number, number, number] = [0, 0, 0, 0];
  private gameStartChips: [number, number, number, number] = [0, 0, 0, 0];
  private sessionDabuken: [boolean, boolean, boolean, boolean] = [
    false,
    false,
    false,
    false,
  ];
  private sessionFinalized = false;
  private pendingSessionEndReason:
    "vote_no" | "vote_timeout" | "single_game" | "server_abort" | null = null;
  private sessionFinalizePromise: Promise<void> | null = null;

  constructor(
    private readonly config: MatchConfiguration,
    private readonly runtime: MatchRuntime,
    private readonly repository: MatchRepository,
    private readonly kernel: MatchKernel,
    private readonly roster: RoomRoster,
    private readonly port: SessionLifecyclePort
  ) {}
  snapshot(): SessionSnapshot {
    return {
      status: this.statusValue,
      startedAt:
        this.startedAt === null ? null : new Date(this.startedAt.getTime()),
      finalized: this.finalized,
      gameIndex: this.gameIndex,
      gameStartLogIdx: this.gameStartLogIdx,
      sessionChips: [...this.sessionChips],
      gameStartChips: [...this.gameStartChips],
      sessionDabuken: [...this.sessionDabuken],
      sessionFinalized: this.sessionFinalized,
      pendingSessionEndReason: this.pendingSessionEndReason,
    };
  }
  restore(snapshot: SessionSnapshot): void {
    this.statusValue = snapshot.status;
    this.startedAt =
      snapshot.startedAt === null
        ? null
        : new Date(snapshot.startedAt.getTime());
    this.finalized = snapshot.finalized;
    this.gameIndex = snapshot.gameIndex;
    this.gameStartLogIdx = snapshot.gameStartLogIdx;
    this.sessionChips = [...snapshot.sessionChips];
    this.gameStartChips = [...snapshot.gameStartChips];
    this.sessionDabuken = [...snapshot.sessionDabuken];
    this.sessionFinalized = snapshot.sessionFinalized;
    this.pendingSessionEndReason = snapshot.pendingSessionEndReason;
  }
  get hasPendingFinalization(): boolean {
    return this.pendingSessionEndReason !== null && !this.sessionFinalized;
  }
  markGameFinalized(): void {
    this.finalized = true;
  }
  startRelay(): void {
    this.statusValue = "playing";
    this.startedAt = new Date(this.runtime.now());
  }
  finishRelay(): void {
    this.statusValue = "finished";
  }

  async start(): Promise<void> {
    this.port.assertNotPaused("start");
    if (this.statusValue !== "waiting") {
      throw new Error(
        `MatchProcess.start: cannot start from status "${this.statusValue}"`
      );
    }
    for (const [seat, p] of this.roster.players()) {
      if (p === null) {
        throw new Error(
          `MatchProcess.start: seat ${seat} is empty; fill bots or claim it first`
        );
      }
    }
    this.statusValue = "playing";
    this.startedAt = new Date(this.runtime.now());
    this.kernel.initialize(
      this.config.seed,
      this.gameIndex,
      this.config.ruleSetOverride
    );
    // Snapshot starting chips for this game so `match_end` can
    // emit the per-game chip delta (Buu-only display in the
    // end-of-game panel). For non-Buu rule sets the starting
    // chips are zero, so the delta stays zero too.
    this.gameStartChips = [...this.kernel.currentState().chips] as [
      number,
      number,
      number,
      number,
    ];
    // Push a fresh `room_state` so clients can dismiss the
    // waiting-room overlay as soon as the match flips to
    // `playing` — otherwise the previously-sent waiting frame
    // keeps the overlay mounted over the live table.
    this.port.broadcastRoomState();

    // Apply debug seed (no validation — dev surface only).
    this.kernel.applyDebugSeed(this.config.debug);

    const matchPlayers: PersistedMatchPlayer[] = [];
    for (const [seat, p] of this.roster.players()) {
      if (p === null) {
        // Already asserted above; satisfies the type narrower.
        continue;
      }
      matchPlayers.push({
        userId: p.userId,
        seat,
        displayName: p.displayName,
        isBot: p.isBot,
      });
    }
    const isBuu = this.kernel.currentState().ruleSet.buuMode;
    const initialEventSeq = this.port.eventCount();
    await this.repository.createMatch({
      matchId: this.currentGameMongoId(),
      seed: this.config.seed,
      ruleSet: this.config.presetId,
      mode: this.kernel.mode,
      spectatorDelayMs: this.config.spectatorDelayMs,
      players: matchPlayers,
      initialEventSeq,
      ...(isBuu
        ? { sessionId: this.config.matchId, gameIndex: this.gameIndex }
        : {}),
    });

    // Track where this game starts in the omniscient log so
    // `archiveCurrentGame` can slice precisely on match_end.
    this.gameStartLogIdx = initialEventSeq;
    this.port.openEventJournal(this.currentGameMongoId(), initialEventSeq);

    await this.port.emitEvent({
      type: "match_start",
      seats: matchPlayers.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        displayName: p.displayName,
      })),
      ruleSet: this.config.presetId,
      riichiBetValue: this.kernel.currentState().ruleSet.riichiBetValue,
      uraDoraEnabled: this.kernel.currentState().ruleSet.uraDora,
      ...(this.kernel.currentState().ruleSet.scoreCap
        ? { scoreCap: this.kernel.currentState().ruleSet.scoreCap }
        : {}),
      ...(this.kernel.currentState().ruleSet.buuMode
        ? {
            chips: [...this.kernel.currentState().chips] as [
              number,
              number,
              number,
              number,
            ],
            dabuken: [...this.kernel.currentState().dabuken] as [
              boolean,
              boolean,
              boolean,
              boolean,
            ],
          }
        : {}),
    });

    // Pre-match ready check. Bots are pre-acked; if the human
    // is the only seat that hasn't acked we wait up to
    // `READY_CHECK_MS` for their ack before dealing.
    await this.port.runReadyCheck(legacyTiming.READY_CHECK_MS, "initial_hand");

    await this.port.beginInitialHandAfterReady();
  }

  async endMatch(
    reason: "exhaustive_draw" | "ron" | "tsumo" | "abort",
    opts: {
      skipHandEnd?: boolean;
      finalScores?: [number, number, number, number];
      matchEndReason?: MatchEndReason;

      serverAbort?: boolean;
    } = {}
  ): Promise<void> {
    if (this.sessionFinalized) {
      return;
    }
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    if (!opts.skipHandEnd) {
      await this.port.emitEvent({ type: "hand_end", reason });
    }
    const rawScores: readonly [number, number, number, number] =
      opts.finalScores ?? this.kernel.currentState().scores;

    const ordered = [0, 1, 2, 3]
      .map((s) => ({ seat: s as Seat, score: rawScores[s] }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.seat - b.seat;
      });
    const placeBySeat = new Map<Seat, 1 | 2 | 3 | 4>();
    for (let i = 0; i < ordered.length; i++) {
      placeBySeat.set(ordered[i].seat, (i + 1) as 1 | 2 | 3 | 4);
    }
    const finalScores = [0, 1, 2, 3].map((s) => ({
      seat: s as Seat,
      score: rawScores[s],
      place: placeBySeat.get(s as Seat) as 1 | 2 | 3 | 4,
    }));

    const isBuu = this.kernel.currentState().ruleSet.buuMode;
    let chipsDelta: [number, number, number, number] | null = null;
    if (isBuu) {
      const settledChips = this.kernel.settleBuuGame();

      chipsDelta = [
        settledChips[0],
        settledChips[1],
        settledChips[2],
        settledChips[3],
      ];
      this.sessionChips = [...this.kernel.currentState().chips] as [
        number,
        number,
        number,
        number,
      ];
      this.sessionDabuken = [...this.kernel.currentState().dabuken] as [
        boolean,
        boolean,
        boolean,
        boolean,
      ];
    }
    await this.port.emitEvent({
      type: "match_end",
      reason: opts.matchEndReason ?? "round_limit",
      finalScores,
      ...(isBuu
        ? {
            chips: [...this.sessionChips],
            dabuken: [...this.sessionDabuken],
            gameIndex: this.gameIndex,
            ...(chipsDelta ? { chipsDelta } : {}),
          }
        : {}),
    });
    await this.port.archiveCurrentGame(finalScores);

    if (isBuu && !opts.serverAbort) {
      if (legacyTiming.MATCH_END_DISPLAY_MS > 0) {
        await this.port.runUncheckpointableTransition(
          "match_end_display",
          legacyTiming.MATCH_END_DISPLAY_MS
        );
      }
      const cont = await this.port.runContinueVote(finalScores);
      await this.continueAfterVote(cont, finalScores);
      return;
    }
    await this.finalizeSession(
      opts.serverAbort ? "server_abort" : "single_game"
    );
  }

  currentGameMongoId(): string {
    if (!this.kernel.currentState()?.ruleSet.buuMode) {
      return this.config.matchId;
    }
    return `${this.config.matchId}-g${this.gameIndex}`;
  }

  async continueAfterVote(
    cont: boolean,
    finalScores: FinalScore[]
  ): Promise<void> {
    if (cont) {
      await this.startNextGame(finalScores);
      return;
    }
    await this.finalizeSession(this.port.lastVoteReason() ?? "vote_no");
  }

  async startNextGame(finalScores: FinalScore[]): Promise<void> {
    const winnerEntry = finalScores.find((f) => f.place === 1);
    if (!winnerEntry) {
      await this.finalizeSession("server_abort");
      return;
    }
    const winnerOldSeat = winnerEntry.seat;
    const others = ([0, 1, 2, 3] as Seat[]).filter((s) => s !== winnerOldSeat);
    const rngSeed = (this.config.seed + (this.gameIndex + 1) * 0x9e3779b9) | 0;
    const shuffled = deterministicShuffle(others, rngSeed);
    const perm: [Seat, Seat, Seat, Seat] = [
      winnerOldSeat,
      shuffled[0],
      shuffled[1],
      shuffled[2],
    ];

    const oldChips = [...this.sessionChips] as [number, number, number, number];
    const oldDabuken = [...this.sessionDabuken] as [
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    this.roster.permute(perm);
    for (let newSeat = 0; newSeat < 4; newSeat++) {
      const fromSeat = perm[newSeat];
      this.sessionChips[newSeat] = oldChips[fromSeat];
      this.sessionDabuken[newSeat] = oldDabuken[fromSeat];
    }

    this.gameIndex += 1;
    const nextSeed = (this.config.seed + this.gameIndex * 0x9e3779b9) | 0;
    this.kernel.initialize(
      nextSeed,
      this.gameIndex,
      this.config.ruleSetOverride,
      { chips: this.sessionChips, dabuken: this.sessionDabuken }
    );

    this.gameStartChips = [...this.kernel.currentState().chips] as [
      number,
      number,
      number,
      number,
    ];

    this.port.resetCallState();

    this.port.resetRiichiTiles();
    this.port.refillBank();
    this.finalized = false;
    for (let s = 0; s < 4; s++) {
      this.port.clearLegals(s as Seat);
    }

    const matchPlayers: PersistedMatchPlayer[] = [];
    for (const [seat, p] of this.roster.players()) {
      if (p === null) {
        continue;
      }
      matchPlayers.push({
        userId: p.userId,
        seat,
        displayName: p.displayName,
        isBot: p.isBot,
      });
    }

    const initialEventSeq = this.port.eventCount();
    await this.repository.createMatch({
      matchId: this.currentGameMongoId(),
      seed: nextSeed,
      ruleSet: this.config.presetId,
      mode: this.kernel.mode,
      spectatorDelayMs: this.config.spectatorDelayMs,
      players: matchPlayers,
      initialEventSeq,
      sessionId: this.config.matchId,
      gameIndex: this.gameIndex,
    });

    this.port.broadcastRoomState();

    this.gameStartLogIdx = initialEventSeq;
    this.port.openEventJournal(this.currentGameMongoId(), initialEventSeq);

    await this.port.emitEvent({
      type: "match_start",
      seats: matchPlayers.map((p) => ({
        seat: p.seat,
        userId: p.userId,
        displayName: p.displayName,
      })),
      ruleSet: this.config.presetId,
      riichiBetValue: this.kernel.currentState().ruleSet.riichiBetValue,
      uraDoraEnabled: this.kernel.currentState().ruleSet.uraDora,
      ...(this.kernel.currentState().ruleSet.scoreCap
        ? { scoreCap: this.kernel.currentState().ruleSet.scoreCap }
        : {}),
      ...(this.kernel.currentState().ruleSet.buuMode
        ? {
            chips: [...this.kernel.currentState().chips] as [
              number,
              number,
              number,
              number,
            ],
            dabuken: [...this.kernel.currentState().dabuken] as [
              boolean,
              boolean,
              boolean,
              boolean,
            ],
          }
        : {}),
    });

    await this.port.runReadyCheck(legacyTiming.READY_CHECK_MS, "initial_hand");

    await this.port.beginInitialHandAfterReady();
  }

  finalizeSession(
    reason: "vote_no" | "vote_timeout" | "single_game" | "server_abort"
  ): Promise<void> {
    if (this.sessionFinalized) {
      return Promise.resolve();
    }
    if (this.sessionFinalizePromise !== null) {
      return this.sessionFinalizePromise;
    }
    this.pendingSessionEndReason ??= reason;
    const finalizing = this.persistTerminalAndFinalize();
    this.sessionFinalizePromise = finalizing;
    return finalizing;
  }

  async persistTerminalAndFinalize(): Promise<void> {
    const reason = this.pendingSessionEndReason;
    if (reason === null) {
      return;
    }
    try {
      await this.repository.markCheckpointTerminal({
        matchId: this.config.matchId,
        finishedAt: this.runtime.now(),
      });
      this.sessionFinalized = true;
      this.statusValue = "finished";
      await this.port.emitEvent({
        type: "session_end",
        reason,
        gamesPlayed: this.gameIndex + 1,
        chips: [...this.sessionChips],
      });
      this.pendingSessionEndReason = null;
    } finally {
      this.sessionFinalizePromise = null;
    }
  }

  async retryPendingFinalization(): Promise<boolean> {
    if (this.sessionFinalized) {
      return true;
    }
    const reason = this.pendingSessionEndReason;
    if (reason === null) {
      return false;
    }
    await this.finalizeSession(reason);
    return this.sessionFinalized;
  }

  async abortAbandoned(): Promise<void> {
    if (this.port.isPaused()) {
      return;
    }
    if (this.statusValue === "finished" || this.sessionFinalized) {
      return;
    }

    this.port.cancelReadyTimer();

    this.port.cancelActionTimers();

    if (this.port.hasContinueVote()) {
      this.port.finishContinueVote(false);
    }
    await this.finalizeSession("server_abort");
  }
}

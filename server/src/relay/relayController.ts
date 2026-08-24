/**
 * Relay controller: one live Tenhou connection per watched game, fanned out to
 * many spectators.
 *
 * `start(watchId)` is de-duplicated — a second viewer of the same game reuses
 * the existing relay match (and its single upstream Tenhou connection) instead
 * of opening a second one. A relay self-cleans when it has had no spectators
 * for `idleGraceMs`, or when the decoded stream reaches `match_end`.
 */
import { nanoid } from "nanoid";
import { MatchProcess } from "../match";
import type { MatchRepository } from "../repository";
import { TenhouSpectateDecoder } from "~/game/adapters/tenhou/spectateDecoder";
import type { TenhouClientFactory, TenhouSpectateClient } from "./tenhouClient";

/** Thrown by {@link RelayController.start} when the concurrent-relay cap is hit. */
export class RelayCapacityError extends Error {
  constructor(max: number) {
    super(`relay capacity reached (max ${max})`);
    this.name = "RelayCapacityError";
  }
}

interface RelaySession {
  watchId: string;
  matchId: string;
  match: MatchProcess;
  decoder: TenhouSpectateDecoder;
  client: TenhouSpectateClient | null;
  viewers: number;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
}

export interface RelayControllerOptions {
  /** The game-server's live match registry (relay matches are added here). */
  matches: Map<string, MatchProcess>;
  /** Close + drop the spectator sockets for a match (index.ts owns them). */
  closeSpectators: (matchId: string) => void;
  createClient: TenhouClientFactory;
  repository: MatchRepository;
  /** Grace period with zero spectators before a relay tears down. */
  idleGraceMs?: number;
  /** Max concurrent live relays (upstream Tenhou connections). Default 20. */
  maxConcurrent?: number;
  /** Optional structured logger for relay lifecycle events. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export class RelayController {
  private readonly byWatch = new Map<string, RelaySession>();
  private readonly byMatch = new Map<string, RelaySession>();
  private readonly idleGraceMs: number;
  private readonly maxConcurrent: number;
  private readonly log: (event: string, data: Record<string, unknown>) => void;

  constructor(private readonly opts: RelayControllerOptions) {
    this.idleGraceMs = opts.idleGraceMs ?? 60_000;
    this.maxConcurrent = opts.maxConcurrent ?? 20;
    this.log = opts.log ?? ((): void => undefined);
  }

  /** De-duplicated by watch-id: returns an existing relay's matchId or opens one. */
  start(watchId: string): { matchId: string } {
    const existing = this.byWatch.get(watchId);
    if (existing && !existing.closing) {
      this.cancelIdle(existing);
      return { matchId: existing.matchId };
    }
    if (this.byMatch.size >= this.maxConcurrent) {
      this.log("capacity_reached", { watchId, max: this.maxConcurrent });
      throw new RelayCapacityError(this.maxConcurrent);
    }
    const matchId = nanoid(12);
    const match = MatchProcess.createRelayMatch(
      matchId,
      watchId,
      { repository: this.opts.repository }
    );
    this.opts.matches.set(matchId, match);
    const session: RelaySession = {
      watchId,
      matchId,
      match,
      decoder: new TenhouSpectateDecoder(watchId),
      client: null,
      viewers: 0,
      idleTimer: null,
      closing: false,
    };
    session.client = this.opts.createClient(watchId, {
      onFrame: (frame) => this.onFrame(session, frame),
      onClose: () => undefined,
    });
    this.byWatch.set(watchId, session);
    this.byMatch.set(matchId, session);
    session.client.start();
    // No spectator yet — arm the idle timer so an abandoned start self-cleans.
    this.armIdle(session);
    this.log("start", { watchId, matchId, active: this.byMatch.size });
    return { matchId };
  }

  stopByWatch(watchId: string): void {
    const session = this.byWatch.get(watchId);
    if (session) {
      this.teardown(session);
    }
  }

  stopByMatch(matchId: string): void {
    const session = this.byMatch.get(matchId);
    if (session) {
      this.teardown(session);
    }
  }

  /** True when the matchId belongs to a controller-managed relay. */
  managesMatch(matchId: string): boolean {
    return this.byMatch.has(matchId);
  }

  /** Snapshot for the metrics endpoint. */
  stats(): {
    activeRelays: number;
    totalViewers: number;
    maxConcurrent: number;
  } {
    let totalViewers = 0;
    for (const session of this.byMatch.values()) {
      totalViewers += session.viewers;
    }
    return {
      activeRelays: this.byMatch.size,
      totalViewers,
      maxConcurrent: this.maxConcurrent,
    };
  }

  onSpectatorAttached(matchId: string): void {
    const session = this.byMatch.get(matchId);
    if (!session) {
      return;
    }
    session.viewers++;
    this.cancelIdle(session);
  }

  onSpectatorGone(matchId: string): void {
    const session = this.byMatch.get(matchId);
    if (!session) {
      return;
    }
    session.viewers = Math.max(0, session.viewers - 1);
    if (session.viewers === 0) {
      this.armIdle(session);
    }
  }

  private onFrame(session: RelaySession, frame: Record<string, unknown>): void {
    if (session.closing) {
      return;
    }
    let ended = false;
    for (const event of session.decoder.ingest(frame)) {
      session.match.injectRelayEvent(event);
      if (event.type === "match_end") {
        ended = true;
      }
    }
    if (ended) {
      this.teardown(session);
    }
  }

  private armIdle(session: RelaySession): void {
    this.cancelIdle(session);
    session.idleTimer = setTimeout(
      () => this.teardown(session),
      this.idleGraceMs
    );
    session.idleTimer.unref?.();
  }

  private cancelIdle(session: RelaySession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  private teardown(session: RelaySession): void {
    if (session.closing) {
      return;
    }
    session.closing = true;
    this.log("teardown", {
      watchId: session.watchId,
      matchId: session.matchId,
    });
    this.cancelIdle(session);
    try {
      session.client?.stop();
    } catch {
      // ignore
    }
    void session.match.closeRelay();
    this.opts.closeSpectators(session.matchId);
    this.opts.matches.delete(session.matchId);
    this.byWatch.delete(session.watchId);
    this.byMatch.delete(session.matchId);
  }
}

/**
 * Stateful Tenhou spectator decoder for a LIVE relay.
 *
 * The whole-log adapter (`parseTenhouReplayElements`) consumes a complete
 * element list. Live spectating instead arrives as a `UN` frame, an
 * `INITBYLOG` catch-up snapshot, then incremental `WGC` frames. This class
 * accumulates those frames and, on each `ingest`, re-derives the full event
 * list and returns only the events not yet emitted (a monotonic cursor).
 *
 * Reconnect handling: a fresh `INITBYLOG` re-sends the current hand from its
 * `INIT`. Hands are keyed by their `INIT` seed, so a re-sent hand REPLACES the
 * prior (shorter) copy instead of appending — the re-parse then reproduces the
 * same event prefix and the cursor skips everything already emitted.
 */
import type { GameEvent } from "~/game/protocol/messages";
import { parseTenhouReplayElements, type TenhouReplayElement } from "./replayAdapter";
import { normalizeElement } from "./spectateHarAdapter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class TenhouSpectateDecoder {
  private unElement: TenhouReplayElement | null = null;
  private readonly handOrder: string[] = [];
  private readonly hands = new Map<string, TenhouReplayElement[]>();
  private currentSeed: string | null = null;
  private emitted = 0;

  constructor(private readonly sourceId: string = "tenhou-live") {}

  /** Feed one already-JSON-parsed server frame; returns newly emitted events. */
  ingest(frame: unknown): GameEvent[] {
    if (!isRecord(frame) || typeof frame.tag !== "string") {
      return [];
    }
    if (frame.tag === "UN") {
      if (!this.unElement) {
        this.unElement = normalizeElement(frame);
      }
    } else if (frame.tag === "INITBYLOG" || frame.tag === "WGC") {
      if (Array.isArray(frame.childNodes)) {
        this.ingestChildNodes(frame.childNodes);
      }
    }
    return this.emit();
  }

  private ingestChildNodes(childNodes: unknown[]): void {
    for (const child of childNodes) {
      if (typeof child === "number") {
        continue;
      }
      const element = normalizeElement(child);
      if (!element) {
        continue;
      }
      if (element.tag === "INIT") {
        const seed = element.attrs.seed ?? `hand-${this.handOrder.length}`;
        this.currentSeed = seed;
        if (!this.hands.has(seed)) {
          this.handOrder.push(seed);
        }
        this.hands.set(seed, [element]);
      } else if (this.currentSeed !== null) {
        const bucket = this.hands.get(this.currentSeed);
        if (bucket) {
          bucket.push(element);
        }
      }
    }
  }

  private buildElements(): TenhouReplayElement[] {
    const elements: TenhouReplayElement[] = [];
    if (this.unElement) {
      elements.push(this.unElement);
    }
    for (const seed of this.handOrder) {
      const bucket = this.hands.get(seed);
      if (bucket) {
        elements.push(...bucket);
      }
    }
    return elements;
  }

  private emit(): GameEvent[] {
    const elements = this.buildElements();
    if (elements.length === 0) {
      return [];
    }
    let events: GameEvent[];
    try {
      events = parseTenhouReplayElements(elements, this.sourceId).events;
    } catch {
      return [];
    }
    // The stream is open-ended; drop the whole-log parser's synthetic
    // `match_end` until Tenhou reports an actual `owari`.
    if (events.at(-1)?.type === "match_end" && !hasOwari(elements)) {
      events = events.slice(0, -1);
    }
    if (events.length <= this.emitted) {
      return [];
    }
    const delta = events.slice(this.emitted);
    this.emitted = events.length;
    return delta;
  }
}

function hasOwari(elements: TenhouReplayElement[]): boolean {
  return elements.some(
    (element) =>
      (element.tag === "AGARI" || element.tag === "RYUUKYOKU") &&
      element.attrs.owari !== undefined
  );
}

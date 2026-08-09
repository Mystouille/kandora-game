import type { GameEvent } from "~/game/protocol/messages";
import type { ReplayLog } from "~/game/replay/types";
import {
  parseTenhouReplayElements,
  type TenhouReplayElement,
} from "./replayAdapter";

export interface HarWebSocketMessage {
  type?: unknown;
  time?: unknown;
  data?: unknown;
}

interface MutableSpectateSession {
  watchId: string | null;
  startedAtMs: number;
  firstGameElementIndex: number | null;
  initialFeedDelayMs: number;
  elements: TenhouReplayElement[];
  timings: TenhouSpectateTiming[];
}

export interface TenhouSpectateTiming {
  /** Index of the normalized element that follows this delay value. */
  elementIndex: number;
  delayMs: number;
}

export interface TenhouHarSpectateSession {
  watchId: string | null;
  startedAtMs: number;
  /** Wall-clock wait from GO until the first INITBYLOG/WGC game payload. */
  initialFeedDelayMs: number;
  complete: boolean;
  elementCount: number;
  timings: TenhouSpectateTiming[];
  /** Delay before each corresponding `events[index]` entry. */
  eventDelaysMs: number[];
  events: GameEvent[];
  replay: ReplayLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function harMessageTimeMs(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

export function normalizeElement(
  value: unknown
): TenhouReplayElement | null {
  if (!isRecord(value) || typeof value.tag !== "string") {
    return null;
  }
  const attrs: Record<string, string> = {};
  for (const [key, attrValue] of Object.entries(value)) {
    if (key === "tag" || key === "childNodes" || attrValue === undefined) {
      continue;
    }
    if (
      typeof attrValue === "string" ||
      typeof attrValue === "number" ||
      typeof attrValue === "boolean"
    ) {
      attrs[key] = String(attrValue);
    }
  }
  return { tag: value.tag, attrs };
}

export function websocketMessagesFromHar(
  rawHar: string
): HarWebSocketMessage[] {
  const parsed: unknown = JSON.parse(rawHar);
  if (!isRecord(parsed) || !isRecord(parsed.log)) {
    throw new Error("HAR is missing log metadata.");
  }
  const entries = parsed.log.entries;
  if (!Array.isArray(entries)) {
    throw new Error("HAR is missing log entries.");
  }

  const messages: HarWebSocketMessage[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry._webSocketMessages)) {
      continue;
    }
    for (const message of entry._webSocketMessages) {
      if (isRecord(message)) {
        messages.push(message);
      }
    }
  }
  messages.sort((left, right) => Number(left.time) - Number(right.time));
  return messages;
}

function withoutSyntheticMatchEnd(replay: ReplayLog): ReplayLog {
  if (replay.events.at(-1)?.type !== "match_end") {
    return replay;
  }
  return { ...replay, events: replay.events.slice(0, -1) };
}

function emittedEventCount(
  elements: TenhouReplayElement[],
  index: number,
  hasMatchStart: boolean
): number {
  const element = elements[index];
  if (element.tag === "UN") {
    return hasMatchStart ? 0 : 1;
  }
  if (
    element.tag === "INIT" ||
    element.tag === "DORA" ||
    element.tag === "RYUUKYOKU" ||
    /^[TUVW]\d+$/.test(element.tag) ||
    /^[DEFG]\d+$/.test(element.tag)
  ) {
    return 1;
  }
  if (element.tag === "AGARI") {
    return elements[index + 1]?.tag === "AGARI" ? 1 : 2;
  }
  if (element.tag === "N") {
    const meld = Number(element.attrs.m ?? 0);
    const hasCallMarker =
      (meld & (1 << 2)) !== 0 ||
      (meld & (1 << 3)) !== 0 ||
      (meld & (1 << 4)) !== 0;
    const isNuki = !hasCallMarker && (meld & (1 << 5)) !== 0;
    return isNuki ? 0 : 1;
  }
  return 0;
}

function projectEventDelays(
  elements: TenhouReplayElement[],
  timings: TenhouSpectateTiming[],
  eventCount: number,
  initialFeedDelay?: TenhouSpectateTiming
): number[] {
  const delayByElement = new Map<number, number>();
  if (initialFeedDelay) {
    delayByElement.set(
      initialFeedDelay.elementIndex,
      initialFeedDelay.delayMs
    );
  }
  for (const timing of timings) {
    delayByElement.set(
      timing.elementIndex,
      (delayByElement.get(timing.elementIndex) ?? 0) + timing.delayMs
    );
  }

  const eventDelays: number[] = [];
  let pendingDelay = 0;
  let hasMatchStart = false;
  for (let index = 0; index < elements.length; index++) {
    pendingDelay += delayByElement.get(index) ?? 0;
    const emitted = emittedEventCount(elements, index, hasMatchStart);
    if (elements[index].tag === "UN" && emitted > 0) {
      hasMatchStart = true;
    }
    for (let eventOffset = 0; eventOffset < emitted; eventOffset++) {
      eventDelays.push(eventOffset === 0 ? pendingDelay : 0);
    }
    if (emitted > 0) {
      pendingDelay = 0;
    }
  }

  while (eventDelays.length < eventCount) {
    eventDelays.push(0);
  }
  return eventDelays.slice(0, eventCount);
}

/**
 * Convert captured Tenhou spectator frames into independent catch-up sessions.
 *
 * Each received `GO` starts a new session. Repeated joins to the same watch id
 * are intentionally kept separate because each `INITBYLOG` is a fresh
 * catch-up snapshot and may overlap events from an earlier connection.
 */
export function parseTenhouSpectateHar(
  rawHar: string
): TenhouHarSpectateSession[] {
  const messages = websocketMessagesFromHar(rawHar);
  const sessions: MutableSpectateSession[] = [];
  let pendingWatchId: string | null = null;
  let current: MutableSpectateSession | null = null;

  for (const message of messages) {
    const payload = parseJsonRecord(message.data);
    if (!payload || typeof payload.tag !== "string") {
      continue;
    }

    if (message.type === "send" && payload.tag === "WG") {
      pendingWatchId = typeof payload.id === "string" ? payload.id : null;
      continue;
    }
    if (message.type !== "receive") {
      continue;
    }

    if (payload.tag === "GO") {
      current = {
        watchId: pendingWatchId,
        startedAtMs: harMessageTimeMs(message.time),
        firstGameElementIndex: null,
        initialFeedDelayMs: 0,
        elements: [],
        timings: [],
      };
      sessions.push(current);
      continue;
    }
    if (!current) {
      continue;
    }

    if (payload.tag === "UN") {
      const element = normalizeElement(payload);
      if (element) {
        current.elements.push(element);
      }
      continue;
    }
    if (
      (payload.tag !== "INITBYLOG" && payload.tag !== "WGC") ||
      !Array.isArray(payload.childNodes)
    ) {
      continue;
    }

    if (
      current.firstGameElementIndex === null &&
      payload.childNodes.length > 0
    ) {
      current.firstGameElementIndex = current.elements.length;
      current.initialFeedDelayMs = Math.max(
        0,
        harMessageTimeMs(message.time) - current.startedAtMs
      );
    }

    for (const child of payload.childNodes) {
      if (typeof child === "number" && Number.isFinite(child)) {
        current.timings.push({
          elementIndex: current.elements.length,
          delayMs: child,
        });
        continue;
      }
      const element = normalizeElement(child);
      if (element) {
        current.elements.push(element);
      }
    }
  }

  return sessions
    .filter((session) => session.elements.length > 0)
    .map((session, index) => {
      const complete = session.elements.some(
        (element) =>
          (element.tag === "AGARI" || element.tag === "RYUUKYOKU") &&
          element.attrs.owari !== undefined
      );
      const sourceId = `${session.watchId ?? "unknown"}-capture-${index + 1}`;
      const parsedReplay = parseTenhouReplayElements(
        session.elements,
        sourceId
      );
      const replay = complete
        ? parsedReplay
        : withoutSyntheticMatchEnd(parsedReplay);
      const eventDelaysMs = projectEventDelays(
        session.elements,
        session.timings,
        replay.events.length,
        session.firstGameElementIndex === null
          ? undefined
          : {
              elementIndex: session.firstGameElementIndex,
              delayMs: session.initialFeedDelayMs,
            }
      );
      return {
        watchId: session.watchId,
        startedAtMs: session.startedAtMs,
        initialFeedDelayMs: session.initialFeedDelayMs,
        complete,
        elementCount: session.elements.length,
        timings: session.timings,
        eventDelaysMs,
        events: replay.events,
        replay,
      };
    });
}
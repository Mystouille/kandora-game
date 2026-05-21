import { useEffect, useMemo, useRef, useState } from "react";
import { Link, redirect, useSearchParams } from "react-router";
import { adapter } from "~/game/portal-adapter";
import type { TableRenderer } from "~/game/client/pixi/TableRenderer";
import {
  applyReplayEvent,
  initialView,
  replayBounds,
  replayViewToMatchView,
  roundBoundaries,
} from "~/game/replay/player";
import type { ReplayView } from "~/game/replay/player";
import type { GameEvent, Seat } from "~/game/protocol/messages";
import { ReplayLogModel, type DbReplayLog } from "~/db/models/ReplayLog";
import { ReplayReviewModel } from "~/db/models/ReplayReview";
import { inferReplaySource } from "~/game/replay/inferSource";
import { fetchOrphanReplayLog } from "~/game/replay/fetchOrphanReplayLog.server";
import { annotateWallSchedule } from "~/game/replay/annotateWallSchedule";
import { annotateWaits } from "~/game/replay/annotateWaits";
import {
  bytesToBase64,
  base64ToBytes,
  decodeDrawing,
  encodeDrawing,
  type Drawing,
  type Stroke,
} from "~/game/replay/reviewDrawing";
import type { ReplayLog, ReplaySource } from "~/game/replay/types";
import { getAuthenticatedUser } from "~/utils/jwt.server";
import { basePath } from "~/utils/basePath";
import type { Route } from "./+types/replay";
import {
  ReplayOverlayPanel,
  defaultReplayOverlayState,
  type ReplayOverlayState,
} from "./ReplayOverlayPanel";
import { ReplayDrawingOverlay } from "./ReplayDrawingOverlay";
import {
  ReplayReviewCartridge,
  type ReviewDraft,
} from "./ReplayReviewCartridge";
import { useLocale } from "~/contexts/LocaleContext";
import { FixedTileSetProvider } from "~/contexts/TileSetContext";
import { TileSetName } from "~/components/mahjong/handLayout";
import { ArticleContent } from "~/components/ArticleContent";
import { Tooltip, message } from "antd";
import {
  QuestionOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  SoundOutlined,
  AudioMutedOutlined,
} from "@ant-design/icons";
import {
  isGameSoundEnabled,
  setGameSoundEnabled,
  playSoundForEvent,
} from "~/game/client/sound";

/**
 * Loader-serialized shape of a `ReplayReview`. Drawing blobs are
 * shipped as base64 so they survive the JSON wire format; the
 * client decodes them lazily per event.
 */
interface SerializedReviewEdit {
  eventIndex: number;
  text: string;
  drawingBase64: string | null;
  updatedAt: string;
}
interface SerializedReview {
  shortId: string;
  source: ReplaySource;
  sourceGameId: string;
  createdBy: string;
  /**
   * The seat (0–3) this review is bound to. `null` while the
   * review has no edits yet — the author can still freely change
   * their focused seat. Once the first edit is persisted the seat
   * is locked server-side.
   */
  seat: number | null;
  edits: SerializedReviewEdit[];
}
/**
 * Convert whatever Mongoose hands us for a Buffer schema field into
 * a plain `Uint8Array`. With `.lean()` the value is typically a
 * `mongoose.mongo.Binary` (BSON), not a Node `Buffer`, and
 * `new Uint8Array(binary)` does NOT extract the underlying bytes —
 * it yields an empty array. We have to reach into `.buffer` (Node
 * `Buffer`) first.
 */
function unwrapDrawing(raw: unknown): Uint8Array | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  // BSON Binary (what `.lean()` returns for a `Buffer` field).
  if (typeof raw === "object" && raw !== null && "buffer" in raw) {
    const inner = (raw as { buffer: unknown }).buffer;
    if (inner instanceof Uint8Array) {
      return new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength);
    }
  }
  if (raw instanceof Uint8Array) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

function serializeReview(doc: {
  shortId: string;
  source: string;
  sourceGameId: string;
  createdBy: unknown;
  seat?: number | null;
  edits?: Array<{
    eventIndex: number;
    text?: string;
    drawing?: Buffer | null;
    updatedAt?: Date;
  }>;
}): SerializedReview {
  return {
    shortId: doc.shortId,
    source: doc.source as ReplaySource,
    sourceGameId: doc.sourceGameId,
    createdBy: String(doc.createdBy),
    seat: typeof doc.seat === "number" ? doc.seat : null,
    edits: (doc.edits ?? []).map((e) => {
      const bytes = unwrapDrawing(e.drawing);
      return {
        eventIndex: e.eventIndex,
        text: e.text ?? "",
        drawingBase64: bytes && bytes.length > 0 ? bytesToBase64(bytes) : null,
        updatedAt: (e.updatedAt ?? new Date()).toISOString(),
      };
    }),
  };
}

/**
 * `/replays/:gameId` — Phase 4.5 replay viewer.
 *
 * The platform is inferred from the `:gameId` shape via
 * `inferReplaySource`; when inference returns `null` we fall back to
 * a source-agnostic lookup so debug / hand-crafted ids still resolve
 * when a unique row exists.
 *
 * Loader path:
 *   1. Look up the `ReplayLog` row by `(source, sourceGameId)` (or
 *      `sourceGameId` alone when inference returned null).
 *   2. On miss, dispatch to `fetchOrphanReplayLog(source, gameId)`
 *      which talks to the right `*LeagueConnector` to fetch + parse
 *      the platform log and upserts it as an orphan row (no
 *      `Game.replayLogRef` link). This makes replays viewable even
 *      when no `Game` doc exists yet — useful for ad-hoc URLs and
 *      for closing the gap between play-time and the next
 *      hydration cycle.
 *   3. On miss with no inferable source (e.g. hand-crafted id we
 *      don't know how to fetch), throw a 404.
 *
 * The component holds `index` in component state, derives a
 * `ReplayView` via the incremental reducer, and renders the Pixi
 * `TableRenderer` with prev / next / first / last / round picker
 * controls.
 *
 * Not gated by `requireGameEnabled()` — replays are a viewer over
 * already-recorded games (Majsoul / Tenhou / Riichi City logs) and
 * don't touch the live game-server. They remain reachable in
 * environments where the in-app game subsystem is disabled.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const gameId = params.gameId ?? "";
  if (!gameId) {
    throw new Response("Missing replay id.", { status: 404 });
  }

  // Normalize platform-native viewer-link suffixes so that pasting
  // a raw majsoul / Riichi City URL fragment "just works":
  //
  //   - Majsoul appends `_a<accountId>` to its share URLs to mark
  //     which player generated the link. We strip the suffix from
  //     the id and — if the cached replay knows that accountId —
  //     surface the matching seat through the `?seat=` deeplink
  //     param so the viewer opens with that player at the bottom.
  //     Majsoul stashes the per-seat `accountId` (as a string) on
  //     the `match_start` event's `seats[].userId`.
  //   - Riichi City appends `@<n>` (0–3) to a log id to mark which
  //     seat that share link is from. We strip the suffix from the
  //     id and surface the seat through the `?seat=` deeplink
  //     param so the viewer opens with that player at the bottom.
  //
  // Either fixup issues a 302 to the canonical URL so the cleaned
  // form lands in the address bar and downstream caching keys
  // collapse onto a single canonical id.
  // React Router's `redirect()` prepends the configured
  // `basename` (e.g. `/kandora/` in REMOTE dev) to whatever path
  // we hand it, so we must hand it a basename-RELATIVE path —
  // never the raw `url.pathname`, which already includes the
  // basename and would otherwise produce `/kandora/kandora/...`.
  const url = new URL(request.url);
  const majsoulSuffix = /_a\d+$/.exec(gameId);
  if (majsoulSuffix) {
    // Majsoul appends `_a<obfuscated-sharer-id>` to its share
    // URLs. The number is the URL-sharer's account id passed
    // through Majsoul's private web-client encoding (it's NOT the
    // raw `account_id`, NOT a friend-id `searchAccountByPattern`
    // can decode, and in general not one of the seats in the
    // replay anyway — the sharer can be a spectator). So we
    // just strip it for a clean canonical URL and leave the
    // viewer to default to seat 0; the user can pick a seat from
    // the dropdown or pass `?seat=N` explicitly.
    const cleanId = gameId.slice(0, majsoulSuffix.index);
    const qs = url.searchParams.toString();
    throw redirect(`/replays/${cleanId}${qs ? `?${qs}` : ""}`);
  }
  const rcSuffix = /@([0-3])$/.exec(gameId);
  if (rcSuffix) {
    const seat = rcSuffix[1];
    const cleanId = gameId.slice(0, rcSuffix.index);
    const search = new URLSearchParams(url.searchParams);
    if (!search.has("seat")) {
      search.set("seat", seat);
    }
    const qs = search.toString();
    throw redirect(`/replays/${cleanId}${qs ? `?${qs}` : ""}`);
  }

  const source = inferReplaySource(gameId);
  await adapter.ensureDbConnected();

  // Optional ?review=<shortId>: load the review document so the
  // viewer can overlay the reviewer's notes and drawings. We only
  // honor it when the review actually belongs to this replay; this
  // makes the deeplink robust to URL tampering and prevents a stale
  // share-link from polluting an unrelated game.
  const reviewShortId = url.searchParams.get("review");
  let loadedReview: SerializedReview | null = null;
  if (reviewShortId) {
    const reviewDoc = await ReplayReviewModel.findOne({
      shortId: reviewShortId,
    }).lean();
    if (reviewDoc && reviewDoc.sourceGameId === gameId) {
      loadedReview = serializeReview(reviewDoc);
    }
  }

  // Identify the current user (if any) so the component can
  // enable the editing cartridge for the review owner. The
  // replay route itself does not require auth.
  let currentUserId: string | null = null;
  try {
    const payload = await getAuthenticatedUser(request);
    if (payload?.sub) {
      currentUserId = String(payload.sub);
    }
  } catch {
    /* anonymous viewer */
  }

  const query: Record<string, string> = { sourceGameId: gameId };
  if (source) {
    query.source = source;
  }
  const doc = await ReplayLogModel.findOne(query)
    .lean<DbReplayLog & { _id: unknown }>()
    .exec();

  // Cache hit: hand the persisted row straight to the component.
  if (doc) {
    const log: ReplayLog = {
      source: doc.source as ReplaySource,
      sourceGameId: doc.sourceGameId,
      ruleSet: doc.ruleSet,
      ruleSetDetails: doc.ruleSetDetails as Record<string, unknown> | undefined,
      startedAt: doc.startedAt,
      endedAt: doc.endedAt,
      seats: doc.seats as ReplayLog["seats"],
      events: annotateWallSchedule(doc.events as GameEvent[]),
      schemaVersion: doc.schemaVersion,
    };
    // Pre-compute per-event wait snapshots server-side so the
    // renderer never runs shanten on the client.
    const waitsByIndex = annotateWaits(log.events);
    return { log, waitsByIndex, review: loadedReview, currentUserId };
  }

  // Cache miss: try to fetch + parse from the platform on-demand
  // (Phase 4.5 follow-up — orphan logs are fine for now, no
  // `Game.replayLogRef` link is created). We need a source to know
  // which connector to talk to; inference returning `null` means
  // we can only 404.
  if (!source) {
    throw new Response(
      "Replay not yet available; it will appear after the next hydration cycle.",
      { status: 404 }
    );
  }
  const fetched = await fetchOrphanReplayLog(source, gameId).catch((error) => {
    console.error(
      `[replay loader] connector fetch failed for ${source}/${gameId}`,
      error
    );
    return null;
  });
  if (!fetched) {
    throw new Response(
      "Replay not yet available; it will appear after the next hydration cycle.",
      { status: 404 }
    );
  }
  const annotatedLog = {
    ...fetched,
    events: annotateWallSchedule(fetched.events),
  };
  return {
    log: annotatedLog,
    waitsByIndex: annotateWaits(annotatedLog.events),
    review: loadedReview,
    currentUserId,
  };
}

export default function ReplayRoute({ loaderData }: Route.ComponentProps) {
  const {
    log,
    waitsByIndex,
    review: initialReview,
    currentUserId,
  } = loaderData;
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<TableRenderer | null>(null);
  // Mirrors the latest `MatchView` rendered so the renderer's
  // resize callback (mount-time-only closure) always has fresh
  // state to re-render with.
  const latestRenderRef = useRef<ReturnType<
    typeof replayViewToMatchView
  > | null>(null);

  const bounds = useMemo(() => replayBounds(log), [log]);
  const rounds = useMemo(() => roundBoundaries(log), [log]);

  // URL deeplink state. Three optional search params, all
  // independently set so a partial URL still makes sense:
  //   ?seat=N      focused player (0–3)
  //   ?round=N     1-based round ordinal (matches the round
  //                picker). When `event` is absent we jump to
  //                that round's `hand_start`.
  //   ?event=N     absolute event index. When present it is
  //                authoritative for the playhead and `round`
  //                is purely informational.
  // We read these once at mount to seed the initial playhead /
  // focus seat and then stop touching the URL. Syncing on every
  // step was creating a history entry per click which inflated
  // `history.length` and confused the browser back button. The
  // Share button below rebuilds a fresh deeplink on demand from
  // the current state, so users can still copy a precise URL.
  const [searchParams, setSearchParams] = useSearchParams();

  const clampSeat = (n: number): Seat => {
    if (n === 1 || n === 2 || n === 3) {
      return n;
    }
    return 0;
  };
  const clampToBounds = (n: number): number => {
    return Math.max(bounds.min, Math.min(n, bounds.max));
  };

  // Resolve the initial playhead + seat from the URL exactly
  // once at mount; subsequent navigation flows through
  // component state.
  const initial = useMemo(() => {
    const seatRaw = Number(searchParams.get("seat"));
    let seat: Seat = Number.isFinite(seatRaw) ? clampSeat(seatRaw) : 0;
    // When the URL points at a published review that's already
    // bound to a seat, the seat URL param is ignored: a review is
    // a single-perspective document, so viewers always land on
    // the reviewed seat regardless of any `?seat=` they might
    // have inherited from a previous deeplink.
    if (initialReview && typeof initialReview.seat === "number") {
      seat = clampSeat(initialReview.seat);
    }

    const eventRaw = searchParams.get("event");
    if (eventRaw !== null && eventRaw !== "") {
      const n = Number(eventRaw);
      if (Number.isFinite(n)) {
        return { seat, index: clampToBounds(Math.trunc(n)) };
      }
    }
    const roundRaw = searchParams.get("round");
    if (roundRaw !== null && roundRaw !== "") {
      const n = Number(roundRaw);
      if (Number.isFinite(n)) {
        const ord = Math.trunc(n) - 1;
        const r = rounds[ord];
        if (r !== undefined) {
          return { seat, index: clampToBounds(r) };
        }
      }
    }
    // When the URL points at a published review but doesn't
    // pin a specific frame, jump to the first event that
    // actually carries an annotation. Without this the viewer
    // would land on event 0 (or the first hand_start) and see
    // a blank canvas, even though the review has a drawing on
    // some later event.
    if (initialReview && initialReview.edits.length > 0) {
      const firstEdit = initialReview.edits.reduce(
        (min, e) => (e.eventIndex < min ? e.eventIndex : min),
        initialReview.edits[0].eventIndex
      );
      return { seat, index: clampToBounds(firstEdit) };
    }
    // Open one event past the first hand_start when available
    // so the viewer doesn't greet the user with an empty table.
    return { seat, index: rounds[0] ?? bounds.min };
    // Snapshot-only: deliberately ignore later searchParams /
    // bounds / rounds changes here — the playhead is driven by
    // component state from this point on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [index, setIndex] = useState<number>(initial.index);
  const [overlays, setOverlays] = useState<ReplayOverlayState>(
    defaultReplayOverlayState
  );
  const [focusSeat, setFocusSeat] = useState<Seat>(initial.seat);
  const [copied, setCopied] = useState<boolean>(false);
  // Audio toggle: persisted via the same `kandora.game.sound.enabled`
  // localStorage key that the live-game UI uses, so the user's mute
  // preference carries across both surfaces.
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() =>
    isGameSoundEnabled()
  );
  // Play SFX only on forward single-step advances (the cue mapper
  // is meant for the next event "happening"). Jumps via slider /
  // round-skip, backward steps, and the initial mount stay silent
  // so the replay doesn't blast a chord on every navigation.
  const prevIndexRef = useRef<number>(initial.index);
  useEffect(() => {
    const prev = prevIndexRef.current;
    prevIndexRef.current = index;
    if (!soundEnabled) {
      return;
    }
    if (index !== prev + 1) {
      return;
    }
    const ev = log.events[index];
    if (!ev) {
      return;
    }
    playSoundForEvent(ev, focusSeat);
  }, [index, soundEnabled, log.events, focusSeat]);

  // ── Review state ────────────────────────────────────────────────
  // `review` mirrors what the server returned at load time and is
  // updated when we successfully publish edits. `localEdits` holds
  // *unpublished* per-event changes:
  //   * `{ text, drawingBase64 }` — replaces the server edit at
  //     this index when published.
  //   * `null`                    — pending delete of an existing
  //                                 server-side edit at this index.
  // Per-event Save buttons only mutate `localEdits`; nothing hits
  // the network until the user clicks "Publish" in the cartridge.
  // `draft` is the currently-being-composed text/drawing for the
  // playhead; it is discarded whenever the playhead moves.
  const [review, setReview] = useState<SerializedReview | null>(
    initialReview ?? null
  );
  type LocalEditPatch = {
    text: string;
    drawingBase64: string | null;
  } | null;
  const [localEdits, setLocalEdits] = useState<Record<number, LocalEditPatch>>(
    {}
  );
  const [publishing, setPublishing] = useState<boolean>(false);
  const [draft, setDraft] = useState<ReviewDraft>({
    mode: null,
    text: "",
    strokes: [],
  });
  // Discard in-progress edits whenever the playhead moves.
  useEffect(() => {
    setDraft({ mode: null, text: "", strokes: [] });
  }, [index]);
  const canEditReview =
    currentUserId !== null &&
    (review === null || review.createdBy === currentUserId);
  const pendingCount = useMemo(
    () => Object.keys(localEdits).length,
    [localEdits]
  );

  // ── Seat lock ──────────────────────────────────────────────
  // A review is bound to a single seat: every annotation in it
  // is "about" the same player. We derive the effective lock
  // from two sources:
  //   1. `review.seat` once any edit has been persisted (server
  //      authoritative).
  //   2. `localFirstEditSeat` while the author has unpublished
  //      local edits but no published edits yet \u2014 captured at
  //      the moment of the first local edit so the seat selector
  //      can't drift before publish.
  const [localFirstEditSeat, setLocalFirstEditSeat] = useState<Seat | null>(
    null
  );
  // Viewer-side toggle for the saved annotation frame. The eye
  // button next to the annotation flips this on mouse-down so
  // readers can hide a long note that's covering the board
  // without losing it permanently.
  const [savedTextVisible, setSavedTextVisible] = useState<boolean>(true);
  // Same pattern, but for the hand-result / match-end Pixi panel.
  // The eye button next to the panel flips this on mouse-down so
  // viewers can momentarily peek at the board underneath without
  // losing the result overlay permanently.
  const [handResultVisible, setHandResultVisible] = useState<boolean>(true);
  // Canvas-pixel bounds of the result panel reported by
  // `TableRenderer.setResultPanelBoundsListener`. Drives the
  // absolute position of the "hide hand result" eye button so it
  // sits flush against the panel's right edge.
  const [resultPanelBounds, setResultPanelBounds] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  // Global mouseup/touchend listener: while the user presses the
  // eye button the annotation is hidden, but the moment they
  // release the mouse *anywhere* on the page we show it again.
  // Attaching the listener unconditionally is cheap (it does a
  // single `setState` only when the visible flag is already
  // false) and avoids the bookkeeping of add/remove on press.
  useEffect(() => {
    if (savedTextVisible) {
      return;
    }
    const restore = () => setSavedTextVisible(true);
    window.addEventListener("mouseup", restore);
    window.addEventListener("touchend", restore);
    window.addEventListener("touchcancel", restore);
    return () => {
      window.removeEventListener("mouseup", restore);
      window.removeEventListener("touchend", restore);
      window.removeEventListener("touchcancel", restore);
    };
  }, [savedTextVisible]);
  // Mirror restore listener for the hand-result eye button.
  useEffect(() => {
    if (handResultVisible) {
      return;
    }
    const restore = () => setHandResultVisible(true);
    window.addEventListener("mouseup", restore);
    window.addEventListener("touchend", restore);
    window.addEventListener("touchcancel", restore);
    return () => {
      window.removeEventListener("mouseup", restore);
      window.removeEventListener("touchend", restore);
      window.removeEventListener("touchcancel", restore);
    };
  }, [handResultVisible]);
  // Clear the local-first-seat marker the moment all local edits
  // are gone *and* the server has no edits either \u2014 the author
  // is free to re-target the review at a different seat.
  useEffect(() => {
    const serverHasEdits = review !== null && review.edits.length > 0;
    const hasLocal = Object.keys(localEdits).length > 0;
    if (!serverHasEdits && !hasLocal && localFirstEditSeat !== null) {
      setLocalFirstEditSeat(null);
    }
  }, [review, localEdits, localFirstEditSeat]);
  const effectiveReviewSeat: Seat | null = (() => {
    if (review && typeof review.seat === "number") {
      return clampSeat(review.seat);
    }
    return localFirstEditSeat;
  })();
  // Viewers (non-owners) are locked to the review's seat \u2014 the
  // seat dropdown is disabled and the URL `?seat=` param is
  // ignored. The owner is free to switch seats (e.g. to peek at
  // a different perspective) but the cartridge edit buttons go
  // disabled whenever `focusSeat !== effectiveReviewSeat`.
  const seatLockedForViewer =
    review !== null && !canEditReview && effectiveReviewSeat !== null;
  const seatMismatch =
    effectiveReviewSeat !== null && focusSeat !== effectiveReviewSeat;
  const currentEdit = useMemo<SerializedReviewEdit | null>(() => {
    // Local override wins over the server-side edit so the user
    // sees their unpublished changes immediately.
    if (Object.prototype.hasOwnProperty.call(localEdits, index)) {
      const local = localEdits[index];
      if (local === null) {
        return null;
      }
      return {
        eventIndex: index,
        text: local.text,
        drawingBase64: local.drawingBase64,
        updatedAt: new Date().toISOString(),
      };
    }
    if (!review) {
      return null;
    }
    return review.edits.find((e) => e.eventIndex === index) ?? null;
  }, [review, index, localEdits]);
  // Sorted list of event indices that carry an effective comment
  // (text or drawing) after applying local overrides over the
  // server-side review. Drives the "previous/next comment"
  // navigation buttons; empty when no comment exists yet, in which
  // case the buttons hide entirely.
  const commentIndices = useMemo<number[]>(() => {
    const map = new Map<number, { text: string; drawingBase64: string | null }>(
      []
    );
    if (review) {
      for (const e of review.edits) {
        map.set(e.eventIndex, {
          text: e.text,
          drawingBase64: e.drawingBase64,
        });
      }
    }
    for (const key of Object.keys(localEdits)) {
      const idx = Number(key);
      const patch = localEdits[idx];
      if (patch === null) {
        map.delete(idx);
      } else {
        map.set(idx, patch);
      }
    }
    const out: number[] = [];
    for (const [idx, edit] of map) {
      if (edit.text.length > 0 || edit.drawingBase64) {
        out.push(idx);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  }, [review, localEdits]);
  // Decode the saved drawing once per (review,index) pair.
  const savedDrawing = useMemo<Drawing | null>(() => {
    if (!currentEdit?.drawingBase64) {
      return null;
    }
    try {
      return decodeDrawing(base64ToBytes(currentEdit.drawingBase64));
    } catch {
      return null;
    }
  }, [currentEdit]);
  // Strokes to render in the overlay: while drawing, show the
  // user's in-progress strokes; otherwise show the saved drawing
  // \u2014 but only when the focused seat matches the seat the
  // review is bound to. When the owner browses a different seat
  // the drawing is hidden (and a "?" hint is shown next to the
  // text bubble) so the annotation isn't displayed out of
  // context.
  const overlayStrokes: Stroke[] = useMemo(() => {
    if (draft.mode === "pen") {
      return draft.strokes;
    }
    if (seatMismatch) {
      return [];
    }
    return savedDrawing?.strokes ?? [];
  }, [draft.mode, draft.strokes, savedDrawing, seatMismatch]);

  /**
   * Lazily create the review document on the first publish. We do
   * NOT call this until the user explicitly publishes, so an
   * accidental edit doesn't pollute the database with empty
   * reviews. Returns the resulting `shortId` and updates the URL
   * with `?review=...` via `replace` so the back button stays
   * clean.
   */
  const ensureReview = async (): Promise<string | null> => {
    if (review) {
      return review.shortId;
    }
    if (currentUserId === null) {
      return null;
    }
    const res = await fetch(`${basePath}/api/replay-reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: log.source,
        sourceGameId: log.sourceGameId,
      }),
    });
    if (!res.ok) {
      let errBody: unknown = null;
      try {
        errBody = await res.json();
      } catch {
        /* non-JSON */
      }
      console.error("[replay-review] ensureReview failed", res.status, errBody);
      return null;
    }
    const data = (await res.json()) as { ok: boolean; shortId?: string };
    if (!data.ok || !data.shortId) {
      return null;
    }
    const created: SerializedReview = {
      shortId: data.shortId,
      source: log.source,
      sourceGameId: log.sourceGameId,
      createdBy: currentUserId,
      seat: null,
      edits: [],
    };
    setReview(created);
    const next = new URLSearchParams(searchParams);
    next.set("review", data.shortId);
    setSearchParams(next, { replace: true });
    return data.shortId;
  };

  /**
   * Stage an edit at the current event in local state. Nothing is
   * sent over the network — call `publish()` to push everything.
   */
  const commitEditLocally = (patch: {
    text?: string;
    drawingBase64?: string | null;
    delete?: boolean;
  }): void => {
    // Capture the first-edit seat client-side so the cartridge
    // can lock the seat selector before publish. Only meaningful
    // when there's no server-side lock yet.
    const serverLock =
      review && typeof review.seat === "number" ? review.seat : null;
    if (
      serverLock === null &&
      localFirstEditSeat === null &&
      patch.delete !== true &&
      ((typeof patch.text === "string" && patch.text.length > 0) ||
        (typeof patch.drawingBase64 === "string" &&
          patch.drawingBase64.length > 0))
    ) {
      setLocalFirstEditSeat(focusSeat);
    }
    setLocalEdits((prev) => {
      const next: Record<number, LocalEditPatch> = { ...prev };
      // Resolve the "current effective edit" so a partial patch
      // preserves the field we aren't touching.
      const existingLocal = Object.prototype.hasOwnProperty.call(prev, index)
        ? prev[index]
        : undefined;
      const serverEdit =
        review?.edits.find((e) => e.eventIndex === index) ?? null;
      const baseText =
        existingLocal === null
          ? ""
          : (existingLocal?.text ?? serverEdit?.text ?? "");
      const baseDrawing =
        existingLocal === null
          ? null
          : (existingLocal?.drawingBase64 ?? serverEdit?.drawingBase64 ?? null);

      if (patch.delete) {
        if (serverEdit) {
          // Server has something to remove → mark as pending delete.
          next[index] = null;
        } else {
          // No server edit — just drop any local override.
          delete next[index];
        }
        return next;
      }

      const nextText = patch.text !== undefined ? patch.text : baseText;
      let nextDrawing: string | null;
      if (patch.drawingBase64 === undefined) {
        nextDrawing = baseDrawing;
      } else if (patch.drawingBase64 === null || patch.drawingBase64 === "") {
        nextDrawing = null;
      } else {
        nextDrawing = patch.drawingBase64;
      }

      // If the resulting edit matches the server-side edit exactly,
      // drop the local override (no need to publish a no-op).
      const matchesServer =
        (serverEdit?.text ?? "") === nextText &&
        (serverEdit?.drawingBase64 ?? null) === nextDrawing;
      if (matchesServer) {
        delete next[index];
        return next;
      }

      // If the resulting edit is empty AND there is nothing on the
      // server, just drop the local entry.
      if ((!nextText || nextText.length === 0) && !nextDrawing) {
        if (serverEdit) {
          next[index] = null;
        } else {
          delete next[index];
        }
        return next;
      }

      next[index] = { text: nextText, drawingBase64: nextDrawing };
      return next;
    });
  };

  /**
   * Build a share URL for a given `shortId`, pinned to the
   * current playhead. Returns `""` when the URL cannot be built
   * (SSR, or no `shortId` available). Used both by the post-
   * publish flow (where the caller already knows the fresh
   * `shortId`) and by the cartridge's pre-publish path.
   */
  const buildShareUrlFor = (shortId: string | null): string => {
    if (typeof window === "undefined" || !shortId) {
      return "";
    }
    const params = new URLSearchParams();
    params.set("review", shortId);
    // Pin the share link to the current playhead so the viewer
    // lands on the same frame the author was looking at when they
    // hit Publish. Drawings/text are attached to a specific event
    // index — without this the viewer would have to scrub to find
    // them.
    params.set("event", String(index));
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  };

  /**
   * Push every staged edit in `localEdits` to the server. On
   * success, returns the share URL for the published review. On
   * failure, returns `null`. The share URL is built from the
   * freshly-resolved `shortId` so callers don't need to wait for
   * the parent to re-render with the new `review` state — a wait
   * that previously caused the publish modal to require two
   * confirmations on first publish.
   */
  const publish = async (): Promise<string | null> => {
    const entries = Object.entries(localEdits);
    if (entries.length === 0) {
      // Nothing staged — either the review is already published
      // and up to date, or there is no review at all. Build a URL
      // from whatever the parent currently knows so the cartridge
      // can still surface a copyable link.
      return buildShareUrlFor(review?.shortId ?? null);
    }
    setPublishing(true);
    try {
      const shortId = await ensureReview();
      if (!shortId) {
        return null;
      }
      // Track per-index server responses so we can merge them at
      // the end without partial UI flicker.
      const applied: Array<
        | { eventIndex: number; kind: "delete" }
        | { eventIndex: number; kind: "upsert"; edit: SerializedReviewEdit }
      > = [];
      // The server echoes back the locked seat on every response;
      // hold the latest so we can persist it into `review.seat`.
      let lockedSeat: number | null = null;
      for (const [idxStr, patch] of entries) {
        const eventIndex = Number(idxStr);
        const body =
          patch === null
            ? { eventIndex, delete: true }
            : {
                eventIndex,
                text: patch.text,
                drawingBase64: patch.drawingBase64,
                // The server uses this only the *first* time an
                // edit lands on the document (to lock the review
                // to a single seat). Subsequent PUTs simply echo
                // it back; the locked seat wins.
                seat: focusSeat,
              };
        const res = await fetch(
          `${basePath}/api/replay-reviews/${encodeURIComponent(shortId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) {
          let errBody: unknown = null;
          try {
            errBody = await res.json();
          } catch {
            /* non-JSON */
          }
          console.error(
            "[replay-review] publish failed for event",
            eventIndex,
            res.status,
            errBody
          );
          return null;
        }
        if (patch === null) {
          applied.push({ eventIndex, kind: "delete" });
          try {
            const data = (await res.json()) as {
              ok: boolean;
              seat?: number | null;
            };
            if (typeof data.seat === "number" || data.seat === null) {
              lockedSeat = data.seat;
            }
          } catch {
            /* response had no body */
          }
        } else {
          let serverEdit: SerializedReviewEdit | null = null;
          try {
            const data = (await res.json()) as {
              ok: boolean;
              edit?: SerializedReviewEdit | null;
              seat?: number | null;
            };
            serverEdit = data.edit ?? null;
            if (typeof data.seat === "number" || data.seat === null) {
              lockedSeat = data.seat;
            }
          } catch {
            /* response had no body */
          }
          if (serverEdit) {
            applied.push({ eventIndex, kind: "upsert", edit: serverEdit });
          }
        }
      }
      // Merge applied responses into review state.
      setReview((prev) => {
        if (!prev) {
          return prev;
        }
        const editsByIndex = new Map<number, SerializedReviewEdit>();
        for (const e of prev.edits) {
          editsByIndex.set(e.eventIndex, e);
        }
        for (const a of applied) {
          if (a.kind === "delete") {
            editsByIndex.delete(a.eventIndex);
          } else {
            editsByIndex.set(a.eventIndex, a.edit);
          }
        }
        return {
          ...prev,
          seat: lockedSeat !== null ? lockedSeat : prev.seat,
          edits: Array.from(editsByIndex.values()),
        };
      });
      setLocalEdits({});
      // Resolve the share URL synchronously from the freshly-known
      // shortId so the caller doesn't have to wait for the parent
      // to re-render with the updated `review` state.
      return buildShareUrlFor(shortId);
    } finally {
      setPublishing(false);
    }
  };

  /** Drop all staged edits without contacting the server. */
  const discardAll = (): void => {
    setLocalEdits({});
  };

  // Incremental fold: we keep prefix views in a ref so a "next"
  // click is O(1) instead of O(index). Whole-fold path on seek.
  const viewCacheRef = useRef<{
    builtTo: number;
    view: ReplayView;
  } | null>(null);

  const currentView = useMemo<ReplayView>(() => {
    const cache = viewCacheRef.current;
    if (cache && cache.builtTo === index) {
      return cache.view;
    }
    if (cache && index === cache.builtTo + 1) {
      const next = applyReplayEvent(cache.view, log.events[index]);
      viewCacheRef.current = { builtTo: index, view: next };
      return next;
    }
    // Cache miss / backward jump / arbitrary seek — re-fold.
    let v = initialView();
    for (let i = 0; i <= index && i < log.events.length; i++) {
      v = applyReplayEvent(v, log.events[i]);
    }
    viewCacheRef.current = { builtTo: index, view: v };
    return v;
  }, [log, index]);

  // Mount Pixi once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    // Pixi.js touches `navigator` at module-eval time, so it must
    // only load in the browser. Dynamic-import keeps it out of the
    // SSR bundle.
    void import("~/game/client/pixi/TableRenderer").then(
      ({ TableRenderer }) => {
        if (cancelled) {
          return;
        }
        const renderer = new TableRenderer();
        // Wire the resize hook BEFORE mount so the
        // ResizeObserver / Pixi auto-resize installed inside
        // `mount()` can dispatch its first events into a live
        // callback. Previously this was set after `mount()`
        // resolved, which meant any layout shift happening while
        // tile textures were loading was dropped on the floor —
        // contributing to the first-paint dark-canvas race on
        // client-side navigation.
        renderer.setOnRenderRequest(() => {
          const r = rendererRef.current;
          const args = latestRenderRef.current;
          if (r && args) {
            r.render(args);
          }
        });
        renderer.setResultPanelBoundsListener((rect) => {
          setResultPanelBounds(rect);
        });
        // Replay playback should show the win-info panel fully
        // revealed on every seek — the staged per-yaku reveal is
        // only meaningful in live play, where the panel appears
        // exactly once per hand.
        renderer.setStagedRevealEnabled(false);
        void renderer.mount(container).then(() => {
          if (cancelled) {
            renderer.destroy();
            return;
          }
          rendererRef.current = renderer;
          const initialArgs = replayViewToMatchView(currentView, {
            index,
            mySeat: focusSeat,
            matchId: log.sourceGameId,
            seatNames: [
              log.seats[0]?.displayName ?? "",
              log.seats[1]?.displayName ?? "",
              log.seats[2]?.displayName ?? "",
              log.seats[3]?.displayName ?? "",
            ],
            currentWaits: waitsByIndex[index] ?? null,
          });
          latestRenderRef.current = initialArgs;
          renderer.render(initialArgs);
          // First-paint kicker: on client-side navigation the
          // canvas container can still have a zero-size box at
          // the moment Pixi's `Application` materializes (the
          // surrounding flex/grid hasn't fully laid out yet),
          // which leaves the first `render` drawing into an
          // empty viewport — the user sees a dark canvas until
          // they reload. Schedule one more render on the next
          // animation frame so we redraw against the post-layout
          // screen dims; cheap and idempotent.
          requestAnimationFrame(() => {
            if (cancelled) {
              return;
            }
            const r = rendererRef.current;
            const args = latestRenderRef.current;
            if (r && args) {
              r.render(args);
            }
          });
        });
      }
    );
    return () => {
      cancelled = true;
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
    // Mount-once: deliberately ignore `currentView`/`index` here;
    // the dedicated re-render effect below handles updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render on every step.
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setShowLayoutDebug(overlays.showLayoutDebug);
      rendererRef.current.setShowWaits(overlays.showWaits);
      rendererRef.current.setShowHands(overlays.showHands);
      rendererRef.current.setShowWalls(overlays.showWalls);
      rendererRef.current.setShowNames(overlays.showNames);
      rendererRef.current.setShowHandResult(handResultVisible);
      rendererRef.current.setCenterLabels({
        repeat: t.match.centerRepeat,
        riichi: t.match.centerRiichi,
        tiles: t.match.centerTiles,
      });
      rendererRef.current.setResultLabels({
        exhaustiveDraw: t.match.exhaustiveDraw,
        abortTitle: t.match.abortTitle,
        abortKinds: t.match.abortKinds,
        chomboTitle: t.match.chomboTitle,
        chomboReasons: t.match.chomboReasons,
      });
      const args = replayViewToMatchView(currentView, {
        index,
        mySeat: focusSeat,
        matchId: log.sourceGameId,
        seatNames: [
          log.seats[0]?.displayName ?? "",
          log.seats[1]?.displayName ?? "",
          log.seats[2]?.displayName ?? "",
          log.seats[3]?.displayName ?? "",
        ],
        currentWaits: waitsByIndex[index] ?? null,
      });
      latestRenderRef.current = args;
      rendererRef.current.render(args);
    }
  }, [
    currentView,
    index,
    log.sourceGameId,
    log.seats,
    waitsByIndex,
    focusSeat,
    overlays.showLayoutDebug,
    overlays.showWaits,
    overlays.showHands,
    overlays.showWalls,
    overlays.showNames,
    handResultVisible,
    t,
  ]);

  const clamp = (n: number): number =>
    Math.max(bounds.min, Math.min(n, bounds.max));
  const goto = (n: number): void => {
    setIndex(clamp(n));
  };

  // Mouse-wheel scrubbing on the canvas container: scroll down →
  // advance one event, scroll up → rewind one event. Each wheel
  // tick is a single step; we throttle to avoid blasting through
  // a round on a high-resolution trackpad.
  const wheelAccumRef = useRef(0);
  const wheelLastRef = useRef(0);
  // Latest edit-mode flag, kept on a ref so the listener closures
  // below don't need to rebind every time `draft.mode` changes.
  // When the review cartridge is active (text input open or pen
  // mode on) we suppress the wheel / click scrub handlers so they
  // don't fight the user typing or drawing.
  const editingRef = useRef(false);
  editingRef.current = draft.mode !== null;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const onWheel = (e: WheelEvent): void => {
      if (editingRef.current) {
        return;
      }
      e.preventDefault();
      const now = Date.now();
      // Reset the accumulator when the gesture pauses, so an
      // intentional small flick doesn't get diluted by stale dy.
      if (now - wheelLastRef.current > 200) {
        wheelAccumRef.current = 0;
      }
      wheelLastRef.current = now;
      wheelAccumRef.current += e.deltaY;
      const threshold = 30;
      // Snap to the next/previous `discard` or `hand_end` event
      // per tick: draws, melds and dora reveals come in clusters
      // between two discards, so stepping one raw event at a
      // time made the wheel feel like it "skipped" 3+ events per
      // notch without actually moving the picture. Jumping
      // discard-to-discard gives one visible turn change per
      // tick, and stopping on `hand_end` makes the result panel
      // a natural rest point at the end of each round. We cap at
      // *one* step per wheel event regardless of the accumulated
      // delta so a fat trackpad notch doesn't blow past several
      // turns at once.
      const isStop = (i: number): boolean => {
        const t = log.events[i]?.type;
        return t === "discard" || t === "hand_end";
      };
      const findNextDiscard = (i: number): number => {
        for (let j = i + 1; j <= bounds.max; j++) {
          if (isStop(j)) {
            return j;
          }
        }
        return bounds.max;
      };
      const findPrevDiscard = (i: number): number => {
        for (let j = i - 1; j >= bounds.min; j--) {
          if (isStop(j)) {
            return j;
          }
        }
        return bounds.min;
      };
      if (wheelAccumRef.current >= threshold) {
        wheelAccumRef.current = 0;
        // Wheel scrubs are discrete jumps to the next stop — we
        // suppress the discard slide animation for that frame so
        // the pond reads as a static board state rather than a
        // tile sliding in from a hand that didn't visibly exist
        // yet.
        rendererRef.current?.snapNextAnimation();
        setIndex((i) => findNextDiscard(i));
      } else if (wheelAccumRef.current <= -threshold) {
        wheelAccumRef.current = 0;
        rendererRef.current?.snapNextAnimation();
        setIndex((i) => findPrevDiscard(i));
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, [bounds.min, bounds.max, log]);

  // Click scrubbing on the canvas container: left-click → advance
  // one event, right-click → rewind one event. `contextmenu` is
  // suppressed so the right-click step doesn't pop the browser
  // menu. Listeners filter out clicks on overlay panel controls
  // (`button`, `input`, `label`, `select`) so the overlay HUD
  // remains usable.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) {
        return false;
      }
      return (
        target.closest("button, input, label, select, a, [role=button]") !==
        null
      );
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (editingRef.current) {
        return;
      }
      if (e.button !== 0 && e.button !== 2) {
        return;
      }
      if (isInteractiveTarget(e.target)) {
        return;
      }
      e.preventDefault();
      const delta = e.button === 0 ? 1 : -1;
      setIndex((i) => Math.max(bounds.min, Math.min(i + delta, bounds.max)));
    };
    const onContextMenu = (e: MouseEvent): void => {
      if (editingRef.current) {
        return;
      }
      if (isInteractiveTarget(e.target)) {
        return;
      }
      e.preventDefault();
    };
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("contextmenu", onContextMenu);
    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("contextmenu", onContextMenu);
    };
  }, [bounds.min, bounds.max]);

  // For the round picker label.
  const currentRound = (() => {
    if (index < 0) {
      return "—";
    }
    return `${currentView.roundWind}${currentView.roundNumber}`;
  })();

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
    >
      <div
        ref={containerRef}
        className="relative w-full h-full bg-black overflow-hidden"
        style={{ touchAction: "none" }}
      >
        {/* Top-left: replay metadata label. */}
        <div className="pointer-events-none absolute top-2 left-2 z-30 font-mono text-xs text-emerald-100/80 px-2 py-1 rounded bg-black/40">
          replay · {log.source} · {log.sourceGameId} · {currentRound}
        </div>
        {/* Bottom-right: tile-art attribution. */}
        <div className="absolute bottom-2 right-2 z-30 font-mono text-[10px] text-emerald-100/70 px-2 py-1 rounded bg-black/40">
          Tile design copyright of{" "}
          <a
            href="https://tenhou.net/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-emerald-200"
          >
            Tenhou.net
          </a>
          , C-Egg
        </div>
        {/* Top-right: share / publish + close icons.
            When the editor has unpublished local edits the same
            slot turns into a "Publish" button that pushes them
            to the server before copying the share link. */}
        <button
          type="button"
          onClick={() => {
            const next = !soundEnabled;
            setSoundEnabled(next);
            setGameSoundEnabled(next);
          }}
          aria-label={soundEnabled ? "Mute sound" : "Unmute sound"}
          title={soundEnabled ? "Mute sound" : "Unmute sound"}
          className="absolute top-2 right-[13rem] z-30 h-11 w-11 flex items-center justify-center rounded bg-black/70 hover:bg-emerald-800 text-emerald-100 hover:text-white text-xl transition-colors"
        >
          {soundEnabled ? <SoundOutlined /> : <AudioMutedOutlined />}
        </button>
        <button
          type="button"
          onClick={() => {
            const copyToClipboard = (url: string, done: () => void): void => {
              if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(url).then(done, done);
              } else {
                const ta = document.createElement("textarea");
                ta.value = url;
                ta.setAttribute("readonly", "");
                ta.style.position = "absolute";
                ta.style.left = "-9999px";
                document.body.appendChild(ta);
                ta.select();
                try {
                  document.execCommand("copy");
                } catch {
                  /* best-effort */
                }
                document.body.removeChild(ta);
                done();
              }
            };
            const flashCopied = (): void => {
              setCopied(true);
              window.setTimeout(() => {
                setCopied(false);
              }, 1500);
            };
            // Publish path: stage exists. Push edits, then copy
            // the freshly-built share URL.
            if (canEditReview && pendingCount > 0) {
              void publish().then((url) => {
                if (!url) {
                  message.error(t.review.cartridge.publishFailed);
                  return;
                }
                message.success(t.review.cartridge.publishedToast);
                copyToClipboard(url, flashCopied);
              });
              return;
            }
            // Share path: build a fresh deeplink from current state.
            let roundOrdinal = 0;
            for (let i = 0; i < rounds.length; i++) {
              if (rounds[i] <= index) {
                roundOrdinal = i + 1;
              }
            }
            const params = new URLSearchParams();
            params.set("seat", String(focusSeat));
            if (roundOrdinal > 0) {
              params.set("round", String(roundOrdinal));
            }
            params.set("event", String(index));
            const base =
              typeof window !== "undefined"
                ? `${window.location.origin}${window.location.pathname}`
                : "";
            const url = `${base}?${params.toString()}`;
            copyToClipboard(url, flashCopied);
          }}
          disabled={publishing}
          aria-label={
            canEditReview && pendingCount > 0
              ? t.review.cartridge.publishTooltip
              : t.review.cartridge.copyShareLink
          }
          title={
            canEditReview && pendingCount > 0
              ? t.review.cartridge.publishTooltip
              : copied
                ? t.review.cartridge.shareCopied
                : t.review.cartridge.copyShareLink
          }
          className="absolute top-2 right-[7rem] z-30 h-11 min-w-[5.5rem] px-4 flex items-center justify-center gap-1 rounded bg-black/70 hover:bg-emerald-800 text-emerald-100 hover:text-white text-base font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {canEditReview && pendingCount > 0
            ? `${t.review.cartridge.publish} (${pendingCount})`
            : copied
              ? t.review.cartridge.shareCopied
              : t.review.cartridge.share}
        </button>
        <Link
          to="/review"
          aria-label="Close replay"
          className="absolute top-2 right-2 z-30 h-11 min-w-[5.5rem] px-4 inline-flex items-center justify-center gap-1 rounded bg-black/70 hover:bg-emerald-800 text-emerald-100 hover:text-white text-base font-medium no-underline transition-colors"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.7)", color: "#d1fae5" }}
        >
          ✕
        </Link>
        {/* Right-side: seat / round selectors + nav buttons. */}
        <div className="absolute top-1/2 right-2 -translate-y-1/2 z-30 flex flex-col items-stretch gap-3 text-emerald-100 text-base">
          {/* Row 1: seat selection, then round selection. */}
          <div className="flex items-center gap-2">
            <select
              aria-label="Focus seat"
              value={String(focusSeat)}
              onChange={(e) => {
                setFocusSeat(Number(e.target.value) as Seat);
              }}
              disabled={seatLockedForViewer}
              title={
                seatLockedForViewer
                  ? t.review.cartridge.seatLockedViewer
                  : undefined
              }
              className="bg-black/60 border border-emerald-700 rounded px-3 py-2 text-base text-emerald-100 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {([0, 1, 2, 3] as const).map((s) => {
                const name = log.seats[s]?.displayName ?? `Seat ${s}`;
                return (
                  <option key={s} value={String(s)}>
                    {name}
                  </option>
                );
              })}
            </select>
            {rounds.length > 0 && (
              <select
                aria-label="Round"
                value={(() => {
                  let pick = -1;
                  for (const r of rounds) {
                    if (r <= index) {
                      pick = r;
                    }
                  }
                  return pick === -1 ? "" : String(pick);
                })()}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    return;
                  }
                  goto(Number(v));
                }}
                className="bg-black/60 border border-emerald-700 rounded px-3 py-2 text-base text-emerald-100"
              >
                {rounds.map((r, i) => {
                  const ev = log.events[r];
                  if (ev.type !== "hand_start") {
                    return null;
                  }
                  const label = `${ev.roundWind ?? "?"}${ev.roundNumber ?? i + 1}`;
                  return (
                    <option key={r} value={String(r)}>
                      {label}
                    </option>
                  );
                })}
              </select>
            )}
          </div>
          {/* Row 2: prev round, prev event, next event, next round. */}
          {(() => {
            // Find the current round's index in `rounds` (largest
            // boundary <= index). Prev/next round step through that
            // list; first/last are reachable by the bookends.
            let currentRoundIdx = -1;
            for (let i = 0; i < rounds.length; i++) {
              if (rounds[i] <= index) {
                currentRoundIdx = i;
              }
            }
            const prevRound =
              currentRoundIdx > 0 ? rounds[currentRoundIdx - 1] : null;
            const nextRound =
              currentRoundIdx >= 0 && currentRoundIdx < rounds.length - 1
                ? rounds[currentRoundIdx + 1]
                : null;
            return (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    if (prevRound !== null) {
                      goto(prevRound);
                    }
                  }}
                  disabled={prevRound === null}
                  className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Previous round"
                  title="Previous round"
                >
                  ⏮
                </button>
                <button
                  type="button"
                  onClick={() => {
                    goto(index - 1);
                  }}
                  disabled={index <= bounds.min}
                  className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Previous event"
                  title="Previous event"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={() => {
                    goto(index + 1);
                  }}
                  disabled={index >= bounds.max}
                  className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Next event"
                  title="Next event"
                >
                  ▶
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (nextRound !== null) {
                      goto(nextRound);
                    }
                  }}
                  disabled={nextRound === null}
                  className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                  aria-label="Next round"
                  title="Next round"
                >
                  ⏭
                </button>
              </div>
            );
          })()}
          {/* Row 3 (review-only): jump to previous / next event
              that has an annotation. Hidden when no annotation
              exists yet so non-review viewers don't see dead
              buttons. The reviewer's first edit will surface them
              the moment it lands in `localEdits`. */}
          {commentIndices.length > 0 &&
            (() => {
              // Strictly-previous / strictly-next comment index
              // relative to the current playhead. `null` at the
              // ends so the buttons disable cleanly.
              let prevComment: number | null = null;
              let nextComment: number | null = null;
              for (const c of commentIndices) {
                if (c < index) {
                  prevComment = c;
                } else if (c > index && nextComment === null) {
                  nextComment = c;
                }
              }
              return (
                <div className="flex items-center gap-1 justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (prevComment !== null) {
                        goto(prevComment);
                      }
                    }}
                    disabled={prevComment === null}
                    className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                    aria-label="Previous comment"
                    title="Previous comment"
                  >
                    ◀💬
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (nextComment !== null) {
                        goto(nextComment);
                      }
                    }}
                    disabled={nextComment === null}
                    className="px-3 py-2 text-lg rounded bg-black/60 hover:bg-emerald-800 disabled:opacity-40 border border-emerald-700 text-emerald-100"
                    aria-label="Next comment"
                    title="Next comment"
                  >
                    💬▶
                  </button>
                </div>
              );
            })()}
          <span className="font-mono text-sm text-emerald-100/80 text-center">
            {index + 1} / {log.events.length}
          </span>
        </div>
        <ReplayOverlayPanel overlays={overlays} onChange={setOverlays} />
        {/* Review annotations: a passive drawing overlay (shows the
            saved drawing, or the in-progress strokes while drawing)
            plus the cartridge that lets the owner edit text and
            freehand strokes for the current event. */}
        <ReplayDrawingOverlay
          strokes={overlayStrokes}
          drawing={draft.mode === "pen"}
          onStrokesChange={(next) => {
            setDraft((d) => ({ ...d, strokes: next }));
          }}
        />
        {/* Saved-text bubble: visible to all viewers when an edit
            exists for the current event. Rendered through the
            same `ArticleContent` pipeline as news articles so
            inline tiles, hands and links work, and forced into
            the tenhou tile style for visual consistency across
            the review system. The eye button is anchored at a
            fixed offset so it stays put whether the frame is
            visible or not; press-and-hold on it hides the text
            until the user releases the mouse anywhere on screen. */}
        {currentEdit &&
          currentEdit.text.length > 0 &&
          draft.mode !== "text" && (
            <>
              {savedTextVisible ? (
                <div className="absolute bottom-20 left-14 z-30 max-w-[min(820px,calc(100vw-72px))] rounded-lg shadow-lg overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700">
                  <div
                    className="px-5 py-4 text-base text-neutral-900 dark:text-neutral-100 whitespace-pre-wrap rich-text-content"
                    style={{
                      maxHeight: "50vh",
                      overflowY: "auto",
                      // Override `prose-sm`'s 0.875rem base so
                      // review annotations read at a comfortable
                      // size on top of the replay canvas.
                      fontSize: "1rem",
                      lineHeight: 1.6,
                    }}
                  >
                    <FixedTileSetProvider tileSet={TileSetName.Tenhou}>
                      <ArticleContent html={currentEdit.text} />
                    </FixedTileSetProvider>
                  </div>
                </div>
              ) : null}
              <button
                type="button"
                // Press-to-hide: the annotation disappears while
                // the mouse button is held down on the eye, then
                // reappears on `mouseup` anywhere on screen (see
                // the global listener attached in a useEffect).
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSavedTextVisible(false);
                }}
                // Touch-screen parity: hide while finger is down.
                onTouchStart={(e) => {
                  e.preventDefault();
                  setSavedTextVisible(false);
                }}
                className="absolute bottom-20 left-2 z-40 flex h-10 w-10 items-center justify-center rounded-full shadow-lg cursor-pointer select-none text-lg"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.8)",
                  color: "#a7f3d0",
                  border: "1px solid rgba(16, 185, 129, 0.5)",
                }}
                aria-label={t.review.cartridge.hideAnnotation}
              >
                {savedTextVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
              </button>
            </>
          )}
        {/* Hand-result eye button: press-and-hold to temporarily
            hide the win-info panel (after a hand ends) or the
            match-end standings panel so the board state behind
            them is visible. Mirrors the annotation eye's
            press-to-hide / release-to-show pattern via the
            `handResultVisible` global mouseup listener. The
            position is anchored to the panel's right edge in
            canvas pixels (reported by the renderer) so it
            tracks both the centred match-end panel and the
            full-width win-info zone. */}
        {(currentView.lastHandResult || currentView.matchEnded) &&
          resultPanelBounds && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setHandResultVisible(false);
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                setHandResultVisible(false);
              }}
              className="absolute z-40 flex h-10 w-10 items-center justify-center rounded-full shadow-lg cursor-pointer select-none text-lg"
              style={{
                left: resultPanelBounds.x + resultPanelBounds.w + 8,
                top: resultPanelBounds.y + resultPanelBounds.h / 2 - 20,
                backgroundColor: "rgba(0, 0, 0, 0.8)",
                color: "#a7f3d0",
                border: "1px solid rgba(16, 185, 129, 0.5)",
              }}
              aria-label={
                handResultVisible ? "Hide hand result" : "Show hand result"
              }
              title={
                handResultVisible ? "Hide hand result" : "Show hand result"
              }
            >
              {handResultVisible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
            </button>
          )}
        {/* Seat-mismatch hint: when the current event has a saved
            drawing but the owner is looking at a different seat,
            the overlay is hidden so the annotation isn't shown
            out of context. A "?" sitting just to the left of the
            bottom hand tells them which seat to focus on to see
            it. Uses an antd Tooltip with `mouseEnterDelay=0` for
            an instant hint instead of the native browser
            tooltip's ~500ms delay. */}
        {seatMismatch &&
          currentEdit &&
          currentEdit.drawingBase64 &&
          effectiveReviewSeat !== null && (
            <Tooltip
              title={t.review.cartridge.drawingHiddenTooltip.replace(
                "{name}",
                log.seats[effectiveReviewSeat]?.displayName ??
                  `Seat ${effectiveReviewSeat}`
              )}
              mouseEnterDelay={0}
              mouseLeaveDelay={0.1}
              placement="top"
              // Anchor above the page wrapper's stacking context
              // (`z-[9999]`) so the tooltip body isn't hidden.
              zIndex={10001}
              color="#7f1d1d"
            >
              <div
                className="absolute bottom-24 left-8 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-black/80 border-2 border-emerald-600 text-emerald-100 text-3xl font-bold shadow-lg cursor-help select-none pointer-events-auto"
                role="img"
                aria-label={t.review.cartridge.drawingHiddenTooltip.replace(
                  "{name}",
                  log.seats[effectiveReviewSeat]?.displayName ??
                    `Seat ${effectiveReviewSeat}`
                )}
              >
                <QuestionOutlined />
              </div>
            </Tooltip>
          )}
        <ReplayReviewCartridge
          canEdit={canEditReview}
          savedText={currentEdit?.text ?? ""}
          savedHasDrawing={Boolean(currentEdit?.drawingBase64)}
          savedStrokes={savedDrawing?.strokes ?? []}
          draft={draft}
          onDraftChange={setDraft}
          onSubmitText={(text) => {
            commitEditLocally({ text });
          }}
          onSubmitDrawing={(strokes) => {
            const drawing: Drawing = { strokes };
            const bytes = encodeDrawing(drawing);
            commitEditLocally({ drawingBase64: bytesToBase64(bytes) });
          }}
          onErase={() => {
            commitEditLocally({ delete: true });
          }}
          pendingCount={pendingCount}
          publishing={publishing}
          onDiscardAll={discardAll}
          seatMismatch={seatMismatch}
          reviewSeatName={
            effectiveReviewSeat !== null
              ? (log.seats[effectiveReviewSeat]?.displayName ??
                `Seat ${effectiveReviewSeat}`)
              : ""
          }
        />
      </div>
    </div>
  );
}

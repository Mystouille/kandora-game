/**
 * Tenhou replay adapter — Phase 4.5 step 6.
 *
 * Translates a Tenhou game log into a `ReplayLog` consumable by the
 * Phase 4.5 replay route. Tenhou ships logs in two interchangeable
 * formats:
 *
 * - **XML** (`mjloggm` / `mjlog`): the original wire format. The
 *   only one available for tournament/lobby rooms — used by us
 *   today via [parseTenhouGameRecord.ts](./parseTenhouGameRecord.ts)
 *   for the stats pipeline.
 * - **JSON**: the format used by tenhou.net's modern viewer URLs
 *   (`tenhou.net/0/log/?…&tw=…&ts=`). More compact; not always
 *   available for private rooms.
 *
 * Both entry points (`parseTenhouXmlReplay`, `parseTenhouJsonReplay`)
 * funnel through a shared event-builder so the resulting `ReplayLog`
 * is byte-identical regardless of which format the caller had.
 *
 * ## Tile encoding
 *
 * Tenhou XML uses tile **ids** (0–135, four copies per type). Red
 * fives sit at ids 16 (5m), 52 (5p), 88 (5s) — the first tile of
 * each 5-block. Our protocol's `Tile` literal encodes those as
 * `"0m"`, `"0p"`, `"0s"`.
 *
 * Tenhou JSON uses two-digit decimals: `1d` = 1m–9m (`d` ≠ 0),
 * `2d` = 1p–9p, `3d` = 1s–9s, `4d` = 1z–7z. Red fives are
 * `51`/`52`/`53`.
 *
 * ## Coverage
 *
 * Handled: starting hands, draws, discards (incl. tsumogiri and
 * riichi declarations), chi/pon/daiminkan, ankan/shouminkan, dora
 * indicators (initial + kan flips), tsumo/ron (incl. multi-ron),
 * exhaustive draws, abortive draws (kyuushuu, suufon-renda,
 * suucha-riichi, sanchahou).
 *
 * Not handled: 3-player sanma (kita/babei), bot/disconnect markers
 * (`<BYE>` etc.) — these are ignored as they don't affect the
 * replay view.
 */

import type { GameEvent, Meld, Seat, Tile } from "~/game/protocol/messages";
import {
  REPLAY_LOG_SCHEMA_VERSION,
  type ReplayLog,
  type ReplaySeat,
} from "~/game/replay/types";
import { generateTenhouWalls, type TenhouWall } from "./wallGenerator";
import {
  tenhouYakuIdToLegacyHan,
  tenhouYakuIdToRomaji,
} from "~/game/rules";
import { sortYakuRecord } from "~/game/protocol/yakuOrder";

// ---------------------------------------------------------------------------
// Tile decoders
// ---------------------------------------------------------------------------

const SUITS = ["m", "p", "s"] as const;

/** Tenhou XML tile id (0–135) → protocol `Tile`. */
function xmlTileToString(id: number): Tile {
  // Red fives: the first tile of each 5-block in suit order.
  if (id === 16) {
    return "0m" as Tile;
  }
  if (id === 52) {
    return "0p" as Tile;
  }
  if (id === 88) {
    return "0s" as Tile;
  }
  const type = Math.floor(id / 4);
  if (type < 27) {
    const suit = SUITS[Math.floor(type / 9)];
    const num = (type % 9) + 1;
    return `${num}${suit}` as Tile;
  }
  return `${type - 26}z` as Tile;
}

/** Tenhou JSON tile code (11–53) → protocol `Tile`. */
function jsonTileToString(code: number): Tile {
  if (code === 51) {
    return "0m" as Tile;
  }
  if (code === 52) {
    return "0p" as Tile;
  }
  if (code === 53) {
    return "0s" as Tile;
  }
  const suit = Math.floor(code / 10);
  const num = code % 10;
  if (suit === 1) {
    return `${num}m` as Tile;
  }
  if (suit === 2) {
    return `${num}p` as Tile;
  }
  if (suit === 3) {
    return `${num}s` as Tile;
  }
  return `${num}z` as Tile;
}

// ---------------------------------------------------------------------------
// Meld decoder (XML — packs all info into a single `m=` integer)
// ---------------------------------------------------------------------------

/**
 * Decode Tenhou's `<N m="…">` packed meld integer into our protocol
 * `Meld`. The encoding is well-documented in the Tenhou source and
 * mirrored across many open-source viewers.
 *
 * - bit 2 set → chi
 * - bit 3 set → pon
 * - bit 4 set → shouminkan (added kan)
 * - bit 5 set → nuki (kita) — ignored, 3-player only
 * - otherwise → kan (daiminkan if `m & 0x3 !== 0`, ankan if `0`)
 */
function decodeXmlMeld(m: number, callerSeat: Seat): Meld {
  const fromRel = m & 0x3; // 0 = self, 1 = shimocha, 2 = toimen, 3 = kamicha
  const fromAbs: Seat | null =
    fromRel === 0 ? null : (((callerSeat - fromRel + 4) % 4) as Seat);

  if (m & (1 << 2)) {
    // Chi: bits 10–15 hold base + which of the three is the called.
    const t0 = (m >> 3) & 0x3;
    const t1 = (m >> 5) & 0x3;
    const t2 = (m >> 7) & 0x3;
    const baseAndCalled = m >> 10;
    const called = baseAndCalled % 3;
    const baseTile = Math.floor(baseAndCalled / 3);
    const baseType = Math.floor(baseTile / 7) * 9 + (baseTile % 7);
    // Construct three tile ids: baseType+0, baseType+1, baseType+2,
    // each times 4 plus the per-tile offset.
    const tileIds = [
      baseType * 4 + t0,
      (baseType + 1) * 4 + t1,
      (baseType + 2) * 4 + t2,
    ];
    const tiles = tileIds.map(xmlTileToString) as Tile[];
    const claimedTile = tiles[called];
    return { type: "chi", tiles, claimedTile, from: fromAbs };
  }

  if (m & (1 << 3)) {
    // Pon: bits 9–15 hold base; bits 5–6 say which of the four is excluded.
    const unused = (m >> 5) & 0x3;
    const baseAndCalled = m >> 9;
    const called = baseAndCalled % 3;
    const baseType = Math.floor(baseAndCalled / 3);
    // Three tiles of the type, omitting `unused`.
    const tileIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (i !== unused) {
        tileIds.push(baseType * 4 + i);
      }
    }
    const tiles = tileIds.map(xmlTileToString) as Tile[];
    return {
      type: "pon",
      tiles,
      claimedTile: tiles[called] ?? tiles[0],
      from: fromAbs,
    };
  }

  if (m & (1 << 4)) {
    // Shouminkan (added kan): same base layout as pon plus the added tile.
    const added = (m >> 5) & 0x3;
    const baseAndCalled = m >> 9;
    const baseType = Math.floor(baseAndCalled / 3);
    const tiles = [0, 1, 2, 3].map((i) =>
      xmlTileToString(baseType * 4 + i)
    ) as Tile[];
    return {
      type: "shouminkan",
      tiles,
      claimedTile: tiles[added] ?? tiles[0],
      from: null,
    };
  }

  // Kan (daiminkan or ankan).
  const baseTile = m >> 8;
  const baseType = Math.floor(baseTile / 4);
  const tiles = [0, 1, 2, 3].map((i) =>
    xmlTileToString(baseType * 4 + i)
  ) as Tile[];
  if (fromRel === 0) {
    return { type: "ankan", tiles, claimedTile: null, from: null };
  }
  return {
    type: "daiminkan",
    tiles,
    claimedTile: xmlTileToString(baseTile),
    from: fromAbs,
  };
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

export interface TenhouReplayElement {
  tag: string;
  attrs: Record<string, string>;
}

function parseXmlElements(xml: string): TenhouReplayElement[] {
  const elements: TenhouReplayElement[] = [];
  // Tenhou tags start with an uppercase letter. Match opening tags
  // (self-closing or otherwise) with their attribute lists.
  const regex = /<([A-Z]\w*)(\s[^>]*)?\/?>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const tag = match[1];
    const rawAttrs = match[2] ?? "";
    const attrs: Record<string, string> = {};
    const attrRegex = /([\w]+)="([^"]*)"/g;
    let am;
    while ((am = attrRegex.exec(rawAttrs)) !== null) {
      attrs[am[1]] = am[2];
    }
    elements.push({ tag, attrs });
  }
  return elements;
}

function parseStartTimeFromGameId(gameId: string): number {
  // Tenhou game IDs encode the start time: `YYYYMMDDHH…` in JST.
  const m = gameId.match(/^(\d{4})(\d{2})(\d{2})(\d{2})/);
  if (!m) {
    return 0;
  }
  const [, y, mo, d, h] = m;
  return new Date(`${y}-${mo}-${d}T${h}:00:00+09:00`).getTime();
}

/**
 * Parse a Tenhou XML log into a `ReplayLog`.
 *
 * The `gameId` is required — Tenhou doesn't embed it in the XML
 * payload itself; callers (the ingestion pipeline) pass the URL
 * fragment they used to fetch the log.
 */
export function parseTenhouXmlReplay(
  rawXml: string,
  gameId: string
): ReplayLog {
  const elements = parseXmlElements(rawXml);
  return parseTenhouReplayElements(elements, gameId);
}

/**
 * Parse an already-normalized Tenhou tag stream. This is the shared semantic
 * boundary used by XML logs and captured live-spectator JSON child nodes.
 */
export function parseTenhouReplayElements(
  elements: TenhouReplayElement[],
  gameId: string
): ReplayLog {
  if (elements.length === 0) {
    throw new Error("Tenhou replay element stream is empty.");
  }

  const seatNames: string[] = [];
  const events: GameEvent[] = [];
  let scores: [number, number, number, number] = [25000, 25000, 25000, 25000];
  let dealer: Seat = 0;
  let lastDiscardTile: Tile | null = null;
  let lastDiscarder: Seat | null = null;
  let pendingMatchEnd: Array<{
    seat: Seat;
    score: number;
    place: number;
  }> | null = null;
  // Track running dora indicators across the hand so AGARI / next
  // hand_start's `doraIndicators` reflects every flip since INIT.
  let currentDoras: Tile[] = [];
  // Set by `<REACH step="1">`; consumed by the very next discard
  // from that seat (which becomes the riichi declaration tile).
  // Cleared each INIT and after consumption.
  let pendingRiichiSeat: Seat | null = null;

  // Tenhou logs include a `<SHUFFLE seed="mt19937ar-sha512-n288-base64,..."/>`
  // element which lets us deterministically regenerate every kyoku's
  // 136-tile wall via the official algorithm (see `wallGenerator.ts`).
  // We pre-compute all walls up-front: this needs the INIT count and
  // the algorithm is sequential (each kyoku consumes 288 root-MT
  // outputs in order).
  const shuffleEl = elements.find((e) => e.tag === "SHUFFLE");
  const shuffleSeed = shuffleEl?.attrs.seed ?? null;
  const initCount = elements.filter((e) => e.tag === "INIT").length;
  let regeneratedWalls: TenhouWall[] | null = null;
  if (shuffleSeed && initCount > 0) {
    try {
      regeneratedWalls = generateTenhouWalls(shuffleSeed, initCount);
    } catch {
      // Defensive: if a log's seed is somehow malformed, fall back to
      // emitting hand_start events without `liveWall` (the renderer's
      // synthesizer will reconstruct what it can from draw events).
      regeneratedWalls = null;
    }
  }
  let kyokuIdx = 0;

  for (const el of elements) {
    if (el.tag === "UN" && el.attrs.n0 !== undefined) {
      // Player names. May appear at game start AND after disconnect
      // resyncs; later occurrences carry only the rejoining seat.
      // We trust the first occurrence (ie. the only one with all 4).
      if (seatNames.length === 0) {
        for (let i = 0; i < 4; i++) {
          const raw = el.attrs[`n${i}`];
          seatNames.push(raw ? decodeURIComponent(raw) : `Seat ${i}`);
        }
        events.push({
          type: "match_start",
          seats: seatNames.map((name, i) => ({
            seat: i as Seat,
            userId: name,
            displayName: name,
          })),
          ruleSet: "tenhou",
        });
      }
      continue;
    }

    if (el.tag === "INIT") {
      // INIT seed: "round,honba,riichiSticks,dice0,dice1,doraIndicator"
      const seed = (el.attrs.seed ?? "").split(",").map(Number);
      const round = seed[0] ?? 0;
      const honba = seed[1] ?? 0;
      const riichiSticks = seed[2] ?? 0;
      const dice0Raw = seed[3];
      const dice1Raw = seed[4];
      // Tenhou stores dice as 0-5; convert to 1-6 for the wire
      // schema. Drop the pair entirely if either is missing or out
      // of the expected range.
      const dice: [number, number] | null =
        Number.isFinite(dice0Raw) &&
        Number.isFinite(dice1Raw) &&
        dice0Raw >= 0 &&
        dice0Raw <= 5 &&
        dice1Raw >= 0 &&
        dice1Raw <= 5
          ? [dice0Raw + 1, dice1Raw + 1]
          : null;
      const doraIndicator = seed[5] ?? -1;
      const ten = (el.attrs.ten ?? "").split(",").map((s) => Number(s) * 100);
      if (ten.length === 4) {
        scores = [ten[0], ten[1], ten[2], ten[3]];
      }
      dealer = (Number(el.attrs.oya ?? 0) % 4) as Seat;

      const startingHands: [Tile[], Tile[], Tile[], Tile[]] = [
        (el.attrs.hai0 ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => xmlTileToString(Number(s))),
        (el.attrs.hai1 ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => xmlTileToString(Number(s))),
        (el.attrs.hai2 ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => xmlTileToString(Number(s))),
        (el.attrs.hai3 ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => xmlTileToString(Number(s))),
      ];

      currentDoras = doraIndicator >= 0 ? [xmlTileToString(doraIndicator)] : [];
      pendingRiichiSeat = null;

      const roundWindIdx = Math.floor(round / 4);
      const roundWind: "E" | "S" | "W" | "N" =
        roundWindIdx === 0
          ? "E"
          : roundWindIdx === 1
            ? "S"
            : roundWindIdx === 2
              ? "W"
              : "N";
      const roundNumber = (round % 4) + 1;

      // Attach the regenerated live + dead wall so the showWalls
      // overlay can reveal every still-on-the-wall tile face-up.
      const regenWall = regeneratedWalls?.[kyokuIdx];
      const liveWall = regenWall?.liveWall;
      const deadWall = regenWall?.deadWall;
      kyokuIdx++;

      events.push({
        type: "hand_start",
        round,
        dealer,
        roundWind,
        roundNumber,
        honba,
        riichiSticks,
        scores: [...scores],
        startingHands,
        doraIndicators: [...currentDoras],
        dice,
        ...(liveWall ? { liveWall } : {}),
        ...(deadWall ? { deadWall } : {}),
      });
      lastDiscardTile = null;
      lastDiscarder = null;
      continue;
    }

    // Draws: T<id>=seat0, U<id>=seat1, V<id>=seat2, W<id>=seat3.
    if (
      "TUVW".includes(el.tag[0]) &&
      el.tag.length > 1 &&
      /^\d+$/.test(el.tag.slice(1))
    ) {
      const seat = "TUVW".indexOf(el.tag[0]) as Seat;
      const tile = xmlTileToString(Number(el.tag.slice(1)));
      events.push({
        type: "draw",
        seat,
        tile,
        // Tenhou doesn't publish remaining wall on every draw; the
        // reducer derives wallRemaining structurally so an `0` here
        // would be wrong. We leave it at the running value the
        // reducer maintains by passing `0`; the route's HUD won't
        // surface it accurately for Tenhou logs (open question for
        // Step 10's fidelity matrix).
        wallRemaining: 0,
      });
      continue;
    }

    // Discards: D<id>=seat0, E=seat1, F=seat2, G=seat3.
    if (
      "DEFG".includes(el.tag[0]) &&
      el.tag.length > 1 &&
      /^\d+$/.test(el.tag.slice(1))
    ) {
      const seat = "DEFG".indexOf(el.tag[0]) as Seat;
      const tile = xmlTileToString(Number(el.tag.slice(1)));
      const isRiichi = pendingRiichiSeat === seat;
      if (isRiichi) {
        pendingRiichiSeat = null;
      }
      events.push({
        type: "discard",
        seat,
        tile,
        // Tenhou XML doesn't tag tsumogiri explicitly. A future pass
        // can derive it by comparing with the immediately-preceding
        // draw's tile id — left for the fidelity matrix.
        tsumogiri: false,
        ...(isRiichi ? { riichi: true } : {}),
      });
      lastDiscardTile = tile;
      lastDiscarder = seat;
      continue;
    }

    if (el.tag === "N") {
      const seat = (Number(el.attrs.who ?? 0) % 4) as Seat;
      const m = Number(el.attrs.m ?? 0);
      // Skip nuki/kita (3-player only). The kita flag lives at bit
      // 5 BUT only when none of the chi/pon/kan markers (bits 2/3/4)
      // are set — for chi, bit 5 is part of the second tile's offset
      // bits and is unrelated to kita.
      const isCall = (m & (1 << 2)) | (m & (1 << 3)) | (m & (1 << 4));
      if (!isCall && m & (1 << 5)) {
        continue;
      }
      const meld = decodeXmlMeld(m, seat);
      // Use the actual claimed tile for daiminkan/pon/chi when the
      // decoder couldn't pin it down — fall back to last discard.
      if (
        meld.from !== null &&
        lastDiscardTile !== null &&
        (meld.type === "daiminkan" ||
          meld.type === "pon" ||
          meld.type === "chi")
      ) {
        meld.claimedTile = lastDiscardTile;
        meld.from = lastDiscarder;
      }
      events.push({ type: "call", seat, meld });
      continue;
    }

    if (el.tag === "REACH") {
      // Two steps: 1 = declare (the next discard from `who` is the
      // riichi declaration tile, so we flag it via
      // `pendingRiichiSeat`); 2 = stick paid (no event needed —
      // the next hand_start carries the updated `riichiSticks`).
      if (Number(el.attrs.step ?? 0) === 1) {
        pendingRiichiSeat = (Number(el.attrs.who ?? 0) % 4) as Seat;
      }
      continue;
    }

    if (el.tag === "DORA") {
      const indicator = xmlTileToString(Number(el.attrs.hai ?? 0));
      currentDoras.push(indicator);
      events.push({ type: "new_dora", indicator });
      continue;
    }

    if (el.tag === "AGARI") {
      const winner = (Number(el.attrs.who ?? 0) % 4) as Seat;
      const fromWho = (Number(el.attrs.fromWho ?? 0) % 4) as Seat;
      const isTsumo = winner === fromWho;
      const machi = el.attrs.machi
        ? xmlTileToString(Number(el.attrs.machi))
        : undefined;
      const tenParts = (el.attrs.ten ?? "0,0,0").split(",").map(Number);
      const fu = tenParts[0] ?? 0;
      const ten = tenParts[1] ?? 0;
      const yakuPairs = (el.attrs.yaku ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      const yaku: Record<string, string> = {};
      const yakuHan: number[] = [];
      // Tenhou encodes dora as yaku ids: 52 = dora, 53 = ura-dora, 54 = aka.
      let doraCount = 0;
      let akaDoraCount = 0;
      let uraDoraCount = 0;
      for (let i = 0; i + 1 < yakuPairs.length; i += 2) {
        const yakuId = yakuPairs[i];
        const han = yakuPairs[i + 1];
        if (yakuId === 52) {
          doraCount += han;
        } else if (yakuId === 53) {
          uraDoraCount += han;
        } else if (yakuId === 54) {
          akaDoraCount += han;
        }
        const mapped = tenhouYakuIdToLegacyHan(yakuId);
        if (mapped !== undefined) {
          yakuHan.push(mapped);
        }
        const display = tenhouYakuIdToRomaji(yakuId) ?? `y${yakuId}`;
        yaku[display] = `${han}飜`;
      }
      let yakumanCount = 0;
      if (el.attrs.yakuman) {
        const yakumanIds = el.attrs.yakuman
          .split(",")
          .filter(Boolean)
          .map(Number);
        yakumanCount = yakumanIds.length;
        // Yakuman entries don't appear in `yaku`; add them so the
        // win info panel surfaces the yaku name. Value carries the
        // yakuman multiplier in "han" form (single = 13, double =
        // 26, …) so the existing display continues to render a
        // non-zero leading number.
        for (const yakumanId of yakumanIds) {
          const display = tenhouYakuIdToRomaji(yakumanId) ?? `y${yakumanId}`;
          yaku[display] = "役満";
          const mapped = tenhouYakuIdToLegacyHan(yakumanId);
          if (mapped !== undefined) {
            yakuHan.push(mapped);
          }
        }
      }
      const han = yakuPairs
        .filter((_, i) => i % 2 === 1)
        .reduce((a, b) => a + b, 0);
      const sc = (el.attrs.sc ?? "").split(",").map((s) => Number(s) * 100);
      // sc layout: [score0, gain0, score1, gain1, score2, gain2, score3, gain3].
      const delta: number[] = [];
      for (let i = 0; i < 4; i++) {
        delta.push(sc[i * 2 + 1] ?? 0);
      }
      // Update running scores with the gain.
      for (let i = 0; i < 4; i++) {
        scores[i] += delta[i];
      }
      const hand = (el.attrs.hai ?? "")
        .split(",")
        .filter(Boolean)
        .map((s) => xmlTileToString(Number(s)));
      const ura = (el.attrs.doraHaiUra ?? "")
        .split(",")
        .filter(Boolean)
        .map((s) => xmlTileToString(Number(s)));

      events.push({
        type: "win",
        seat: winner,
        loser: isTsumo ? null : fromWho,
        winTile: machi,
        han,
        fu,
        ten,
        yakumanCount,
        yaku: sortYakuRecord(yaku),
        yakuHan,
        doraCount,
        akaDoraCount,
        uraDoraCount,
        hand: hand as Tile[],
        doraIndicators: [...currentDoras],
        uraDoraIndicators: ura as Tile[],
        delta:
          delta.length === 4
            ? [delta[0], delta[1], delta[2], delta[3]]
            : undefined,
      });
      // We may see another AGARI immediately for multi-ron; emit a
      // single hand_end after the AGARI streak. Detect by peeking
      // at the next element.
      const idx = elements.indexOf(el);
      const nextIsAgari = idx >= 0 && elements[idx + 1]?.tag === "AGARI";
      if (!nextIsAgari) {
        events.push({
          type: "hand_end",
          reason: isTsumo ? "tsumo" : "ron",
          delta:
            delta.length === 4
              ? [delta[0], delta[1], delta[2], delta[3]]
              : undefined,
          scores: [...scores],
        });
      }
      if (el.attrs.owari) {
        pendingMatchEnd = parseOwari(el.attrs.owari);
      }
      continue;
    }

    if (el.tag === "RYUUKYOKU") {
      const reason = el.attrs.type;
      const sc = (el.attrs.sc ?? "").split(",").map((s) => Number(s) * 100);
      const delta: [number, number, number, number] = [
        sc[1] ?? 0,
        sc[3] ?? 0,
        sc[5] ?? 0,
        sc[7] ?? 0,
      ];
      for (let i = 0; i < 4; i++) {
        scores[i] += delta[i];
      }
      const tenpai: [boolean, boolean, boolean, boolean] = [
        "hai0" in el.attrs,
        "hai1" in el.attrs,
        "hai2" in el.attrs,
        "hai3" in el.attrs,
      ];
      // Tenhou records each tenpai seat's concealed hand inline
      // on `hai0`/`hai1`/`hai2`/`hai3` (same comma-separated tile-
      // id format used by INIT). Parse them so the renderer can
      // reveal tenpai hands in place at exhaustive draw without
      // having to derive from the projected state.
      const tenpaiHandTiles = (
        key: "hai0" | "hai1" | "hai2" | "hai3"
      ): Tile[] =>
        (el.attrs[key] ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => xmlTileToString(Number(s)));
      const tenpaiHands: (Tile[] | null)[] = [
        tenpai[0] ? tenpaiHandTiles("hai0") : null,
        tenpai[1] ? tenpaiHandTiles("hai1") : null,
        tenpai[2] ? tenpaiHandTiles("hai2") : null,
        tenpai[3] ? tenpaiHandTiles("hai3") : null,
      ];
      const abortKind = mapRyuukyokuAbort(reason);
      events.push({
        type: "hand_end",
        reason: abortKind ? "abort" : "exhaustive_draw",
        ...(abortKind ? { abortKind } : {}),
        delta,
        tenpai: abortKind ? undefined : tenpai,
        ...(abortKind ? {} : { tenpaiHands }),
        scores: [...scores],
      });
      if (el.attrs.owari) {
        pendingMatchEnd = parseOwari(el.attrs.owari);
      }
      continue;
    }
  }

  if (!pendingMatchEnd) {
    // Without an `owari` we still want a `match_end` so the route
    // can render final standings. Derive from running scores.
    pendingMatchEnd = standingsFromScores(scores);
  }
  events.push({
    type: "match_end",
    reason: "round_limit",
    finalScores: pendingMatchEnd,
  });

  const seats: ReplaySeat[] = seatNames.map((name, i) => ({
    seat: i as Seat,
    userId: name,
    displayName: name,
    finalScore: pendingMatchEnd!.find((s) => s.seat === i)?.score ?? 0,
    place: (pendingMatchEnd!.find((s) => s.seat === i)?.place ?? 1) as
      | 1
      | 2
      | 3
      | 4,
  }));

  const startedAt = parseStartTimeFromGameId(gameId);
  return {
    source: "tenhou",
    sourceGameId: gameId,
    ruleSet: "tenhou",
    startedAt,
    endedAt: startedAt, // Tenhou XML doesn't carry an end timestamp.
    seats,
    events,
    schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
  };
}

// Map Tenhou's `<RYUUKYOKU type="…">` discriminant to our
// protocol's `abortKind`. Returns `undefined` for plain exhaustive
// draws (those use `reason: "exhaustive_draw"` instead).
function mapRyuukyokuAbort(
  type: string | undefined
): "kyuushuu" | "suufon_renda" | "suucha_riichi" | "sanchahou" | undefined {
  switch (type) {
    case "yao9":
      return "kyuushuu";
    case "kaze4":
      return "suufon_renda";
    case "reach4":
      return "suucha_riichi";
    case "ron3":
      return "sanchahou";
    default:
      return undefined;
  }
}

function parseOwari(
  raw: string
): Array<{ seat: Seat; score: number; place: number }> {
  const vals = raw.split(",").map(Number);
  const scores: number[] = [];
  for (let i = 0; i < 4; i++) {
    scores.push((vals[i * 2] ?? 0) * 100);
  }
  return standingsFromScores([scores[0], scores[1], scores[2], scores[3]]);
}

function standingsFromScores(
  scores: [number, number, number, number]
): Array<{ seat: Seat; score: number; place: number }> {
  const ranked = [0, 1, 2, 3]
    .map((s) => ({ seat: s as Seat, score: scores[s] }))
    .sort((a, b) => b.score - a.score)
    .map((entry, idx) => ({ ...entry, place: idx + 1 }));
  ranked.sort((a, b) => a.seat - b.seat);
  return ranked;
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Tenhou JSON log shape (the subset we care about). Documented in
 * various open-source Tenhou viewers; not officially specified.
 */
export interface TenhouJsonLog {
  title?: [string, string];
  name?: [string, string, string, string];
  rule?: { disp?: string; aka?: number };
  log: TenhouJsonRound[];
}

/**
 * One round in the JSON log:
 *   [0] roundInfo: [round, honba, riichiSticks]
 *   [1] startingScores (×100)
 *   [2] doraIndicators (decimal tile codes)
 *   [3] uraIndicators (decimal tile codes; empty until win with riichi)
 *   [4..6] hand0, draws0, discards0
 *   [7..9] hand1, draws1, discards1
 *   [10..12] hand2, draws2, discards2
 *   [13..15] hand3, draws3, discards3
 *   [16] endInfo: ["和了", deltas, [winner, loser, pao, fuYakuText, ...]]
 *                or ["流局", deltas, [tenpaiSeats]]
 *                or ["全員聴牌"|"全員不聴", ...] etc.
 *
 * Draws and discards are arrays of either:
 *   - number       → tile code
 *   - "60"         → tsumogiri (discard side only)
 *   - "r<num>"     → riichi declaration discard
 *   - "c<…>"/"p<…>"/"k<…>"/"m<…>"/"a<…>" → call (draws side only)
 */
export type TenhouJsonRound = [
  [number, number, number],
  number[],
  number[],
  number[],
  number[],
  Array<number | string>,
  Array<number | string>,
  number[],
  Array<number | string>,
  Array<number | string>,
  number[],
  Array<number | string>,
  Array<number | string>,
  number[],
  Array<number | string>,
  Array<number | string>,
  ...unknown[],
];

/**
 * Parse a Tenhou JSON log into a `ReplayLog`. `gameId` may be the
 * URL fragment (e.g. `2026041906gm-…-…`) or any opaque id; it goes
 * straight to `sourceGameId`.
 */
export function parseTenhouJsonReplay(
  log: TenhouJsonLog,
  gameId: string
): ReplayLog {
  if (!log.log || log.log.length === 0) {
    throw new Error("Tenhou JSON log has no rounds.");
  }
  const names = log.name ?? ["Seat 0", "Seat 1", "Seat 2", "Seat 3"];
  const events: GameEvent[] = [];
  let scores: [number, number, number, number] = [25000, 25000, 25000, 25000];

  events.push({
    type: "match_start",
    seats: names.map((name, i) => ({
      seat: i as Seat,
      userId: name || `Seat ${i}`,
      displayName: name || `Seat ${i}`,
    })),
    ruleSet: "tenhou",
  });

  for (const round of log.log) {
    const [roundInfo, startingScores, doras, _ura, ...rest] = round;
    void _ura;
    const [roundNum, honba, riichiSticks] = roundInfo;
    if (startingScores.length === 4) {
      scores = [
        startingScores[0],
        startingScores[1],
        startingScores[2],
        startingScores[3],
      ];
    }
    const dealer = (roundNum % 4) as Seat;
    const startingHands: [Tile[], Tile[], Tile[], Tile[]] = [
      (rest[0] as number[]).map(jsonTileToString),
      (rest[3] as number[]).map(jsonTileToString),
      (rest[6] as number[]).map(jsonTileToString),
      (rest[9] as number[]).map(jsonTileToString),
    ];
    const drawStreams: Array<Array<number | string>> = [
      rest[1] as Array<number | string>,
      rest[4] as Array<number | string>,
      rest[7] as Array<number | string>,
      rest[10] as Array<number | string>,
    ];
    const discardStreams: Array<Array<number | string>> = [
      rest[2] as Array<number | string>,
      rest[5] as Array<number | string>,
      rest[8] as Array<number | string>,
      rest[11] as Array<number | string>,
    ];
    const endInfo = rest[12] as
      | [string, number[], unknown[]]
      | [string, number[]]
      | undefined;

    const roundWindIdx = Math.floor(roundNum / 4);
    const roundWind: "E" | "S" | "W" | "N" =
      roundWindIdx === 0
        ? "E"
        : roundWindIdx === 1
          ? "S"
          : roundWindIdx === 2
            ? "W"
            : "N";
    const roundNumber = (roundNum % 4) + 1;
    const currentDoras: Tile[] = doras.map(jsonTileToString);

    events.push({
      type: "hand_start",
      round: roundNum,
      dealer,
      roundWind,
      roundNumber,
      honba,
      riichiSticks,
      scores: [...scores],
      startingHands,
      doraIndicators: [...currentDoras],
    });

    // Replay each seat's draw/discard interleaved by turn order.
    // Seats take turns starting from the dealer. A draw consumes
    // the head of `drawStreams[seat]`, a discard consumes the head
    // of `discardStreams[seat]`. We loop until every seat's draw
    // stream is empty.
    const drawIdx = [0, 0, 0, 0];
    const discardIdx = [0, 0, 0, 0];
    let turn: Seat = dealer;
    let lastDiscardTile: Tile | null = null;
    let lastDiscarder: Seat | null = null;
    let safety = 0;
    while (safety++ < 4096) {
      if (drawIdx[turn] >= drawStreams[turn].length) {
        break;
      }
      const drawEntry = drawStreams[turn][drawIdx[turn]++];
      if (typeof drawEntry === "number") {
        events.push({
          type: "draw",
          seat: turn,
          tile: jsonTileToString(drawEntry),
          wallRemaining: 0,
        });
      } else {
        // Call: format `c<tiles>` (chi), `p<tiles>` (pon),
        // `m<tiles>` (daiminkan), `k<tiles>` (shouminkan, on the
        // *discard* side), `a<tiles>` (ankan, on the discard side).
        const meld = parseJsonCallString(
          drawEntry,
          turn,
          lastDiscardTile,
          lastDiscarder
        );
        if (meld) {
          events.push({ type: "call", seat: turn, meld });
        }
        // After a call the same seat continues — don't rotate yet.
        continue;
      }

      if (discardIdx[turn] >= discardStreams[turn].length) {
        // No discard means the hand ended on this seat's draw
        // (tsumo). End-info is handled below.
        break;
      }
      const discardEntry = discardStreams[turn][discardIdx[turn]++];
      const { tile, tsumogiri, riichi } = decodeJsonDiscard(
        discardEntry,
        drawEntry as number
      );
      if (tile === null) {
        // `k`/`a` self-call mid-discard slot: emit a call event and
        // keep the same seat going.
        const meld = parseJsonCallString(
          String(discardEntry),
          turn,
          null,
          null
        );
        if (meld) {
          events.push({ type: "call", seat: turn, meld });
        }
        continue;
      }
      events.push({
        type: "discard",
        seat: turn,
        tile,
        tsumogiri,
        ...(riichi ? { riichi: true } : {}),
      });
      lastDiscardTile = tile;
      lastDiscarder = turn;

      // Advance to the next seat. If a call follows, the call's
      // seat will be the head of its draw stream; we resync by
      // peeking at the four streams and picking whichever seat has
      // a string at its current draw index.
      let nextSeat: Seat | null = null;
      for (let s = 0; s < 4; s++) {
        const cand = drawStreams[s][drawIdx[s]];
        if (typeof cand === "string" && cand.length > 0) {
          nextSeat = s as Seat;
          break;
        }
      }
      turn = nextSeat ?? (((turn + 1) % 4) as Seat);
    }

    // Round-end info.
    if (endInfo) {
      const kind = endInfo[0];
      const delta = (endInfo[1] ?? [0, 0, 0, 0]) as number[];
      for (let i = 0; i < 4; i++) {
        scores[i] += delta[i] ?? 0;
      }
      if (kind === "和了") {
        const winInfo = (endInfo[2] ?? []) as unknown[];
        const winner = (winInfo[0] as number | undefined) ?? 0;
        const loser = (winInfo[1] as number | undefined) ?? winner;
        const isTsumo = winner === loser;
        events.push({
          type: "win",
          seat: (winner % 4) as Seat,
          loser: isTsumo ? null : ((loser % 4) as Seat),
          delta:
            delta.length === 4
              ? [delta[0], delta[1], delta[2], delta[3]]
              : undefined,
          doraIndicators: [...currentDoras],
        });
        events.push({
          type: "hand_end",
          reason: isTsumo ? "tsumo" : "ron",
          delta:
            delta.length === 4
              ? [delta[0], delta[1], delta[2], delta[3]]
              : undefined,
          scores: [...scores],
        });
      } else {
        // 流局 / 全員聴牌 / 全員不聴 / abortive.
        events.push({
          type: "hand_end",
          reason: kind === "流局" ? "exhaustive_draw" : "abort",
          delta:
            delta.length === 4
              ? [delta[0], delta[1], delta[2], delta[3]]
              : undefined,
          scores: [...scores],
        });
      }
    }
  }

  const finalScores = standingsFromScores(scores);
  events.push({ type: "match_end", reason: "round_limit", finalScores });

  const seats: ReplaySeat[] = names.map((name, i) => ({
    seat: i as Seat,
    userId: name || `Seat ${i}`,
    displayName: name || `Seat ${i}`,
    finalScore: finalScores.find((s) => s.seat === i)?.score ?? 0,
    place: (finalScores.find((s) => s.seat === i)?.place ?? 1) as 1 | 2 | 3 | 4,
  }));

  const startedAt = parseStartTimeFromGameId(gameId);
  return {
    source: "tenhou",
    sourceGameId: gameId,
    ruleSet: "tenhou",
    ruleSetDetails: log.rule
      ? ({ disp: log.rule.disp, aka: log.rule.aka } as Record<string, unknown>)
      : undefined,
    startedAt,
    endedAt: startedAt,
    seats,
    events,
    schemaVersion: REPLAY_LOG_SCHEMA_VERSION,
  };
}

function decodeJsonDiscard(
  entry: number | string,
  drawn: number | undefined
): { tile: Tile | null; tsumogiri: boolean; riichi: boolean } {
  if (typeof entry === "number") {
    return { tile: jsonTileToString(entry), tsumogiri: false, riichi: false };
  }
  // "60" = tsumogiri (discard the just-drawn tile).
  if (entry === "60") {
    return {
      tile: drawn !== undefined ? jsonTileToString(drawn) : ("0m" as Tile),
      tsumogiri: true,
      riichi: false,
    };
  }
  if (entry.startsWith("r")) {
    const code = Number(entry.slice(1));
    if (!Number.isFinite(code)) {
      return { tile: null, tsumogiri: false, riichi: true };
    }
    const tsumogiri = drawn !== undefined && code === drawn;
    return { tile: jsonTileToString(code), tsumogiri, riichi: true };
  }
  // `k<…>` / `a<…>` / etc. — self-call markers on the discard side.
  return { tile: null, tsumogiri: false, riichi: false };
}

function parseJsonCallString(
  entry: string,
  seat: Seat,
  lastDiscardTile: Tile | null,
  lastDiscarder: Seat | null
): Meld | null {
  // Format: `<kind><tile>(<tile>(<tile>)?)?` where `kind` is one of
  // c/p/m/k/a. The called tile's position in the string indicates
  // which player it came from (Tenhou JSON encodes this implicitly
  // by the position of the lowercase prefix). For our protocol we
  // care about the meld type, the tile list, the claimed tile, and
  // the source seat; we approximate the latter two from the most
  // recent discard.
  const kind = entry[0];
  const numbers: number[] = [];
  const re = /\d{2}/g;
  let m;
  while ((m = re.exec(entry)) !== null) {
    numbers.push(Number(m[0]));
  }
  const tiles = numbers.map(jsonTileToString) as Tile[];
  if (tiles.length === 0) {
    return null;
  }
  switch (kind) {
    case "c":
      return {
        type: "chi",
        tiles,
        claimedTile: lastDiscardTile,
        from: lastDiscarder,
      };
    case "p":
      return {
        type: "pon",
        tiles,
        claimedTile: lastDiscardTile,
        from: lastDiscarder,
      };
    case "m":
      return {
        type: "daiminkan",
        tiles,
        claimedTile: lastDiscardTile,
        from: lastDiscarder,
      };
    case "k":
      return {
        type: "shouminkan",
        tiles,
        claimedTile: tiles[0],
        from: null,
      };
    case "a":
      return { type: "ankan", tiles, claimedTile: null, from: null };
    default:
      void seat;
      return null;
  }
}

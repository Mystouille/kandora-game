/**
 * Cross-platform `ReplayLog` → tenhou.net/5 viewer JSON converter.
 *
 * Pure function — no Mongo, no network. Used by the
 * `/api/replay-tenhou-log` endpoint (and the "Export for Naga"
 * client) to produce a tenhou-format log for any source that's
 * already been normalized into our internal `ReplayLog` shape.
 *
 * The output round shape mirrors what the majsoul tensoul port
 * produces (see `app/api/majsoul/tensoul/toTenhouLog.ts`), so the
 * tenhou.net/5 viewer / Naga can consume both interchangeably.
 *
 * ## Encoding cheat sheet
 *
 * Tile: `{1..9}{m|p|s}` → `10·suit + n` (m=1, p=2, s=3); `{1..7}z`
 * → `40 + n`; red five `0X` → `5·10 + suit` (51/52/53).
 *
 * Per-round 17-tuple:
 *   `[ [kyoku, honba, riichiSticks],
 *      [startScore×4],
 *      [doraIndicators…],
 *      [uraDoraIndicators…],
 *      hand0, draws0, discards0,
 *      hand1, draws1, discards1,
 *      hand2, draws2, discards2,
 *      hand3, draws3, discards3,
 *      resultArray ]`
 *
 * `draws[seat]` mixes numeric tile codes with call strings:
 *   `"c{call}{own1}{own2}"`  chi (always from kamicha → 'c' at index 0)
 *   `"…p{call}…"`            pon (call inserted at relative seat index)
 *   `"…m{call}…"`            daiminkan (relative seat index; clamp idx=2→3)
 *
 * `discards[seat]` mixes numeric codes with control strings:
 *   `60`                      tsumogiri sentinel
 *   `"r{tile}"`               riichi declaration tile
 *   `0`                       placeholder dropped after a daiminkan
 *   `"{t1}{t2}{t3}a{t4}"`     ankan
 *   `"k{tile}{…rest}"`        shouminkan (rewrites the prior pon)
 *
 * Result:
 *   `["和了", delta, agari, …more agari for multi-ron]`
 *     `agari = [winner, from, pao, "30符2飜2000点", …yaku strings]`
 *   `["流局", delta]`         exhaustive draw
 *   `["流し満貫", delta]`     nagashi mangan
 *   `["九種九牌"]`            kyuushuu kyuuhai
 *   `["四風連打"]`            suufon renda
 *   `["四家立直"]`            suucha riichi
 *   `["四開槓"]`              suukaikan
 *   `["三家和"]`              sanchahou
 */

import type { GameEvent, ReplayLog } from "~/game/replay/types";
import type { Meld, Tile } from "~/game/protocol/messages";

// ---------------------------------------------------------------------------
// Output shape — kept identical to the majsoul converter so both
// pipelines can land in the same client / viewer.
// ---------------------------------------------------------------------------

export interface Tenhou5Json {
  title: [string, string];
  name: [string, string, string, string];
  rule: { aka: number };
  log: unknown[];
}

// ---------------------------------------------------------------------------
// Tile encoding.
// ---------------------------------------------------------------------------

const SUIT_CODE: Record<string, number> = { m: 1, p: 2, s: 3, z: 4 };
const TSUMOGIRI = 60;

/** Our `Tile` ("0m".."9m" etc.) → tenhou two-digit code. */
function tile(tt: Tile): number {
  const n = parseInt(tt[0], 10);
  const suit = SUIT_CODE[tt[1]];
  if (Number.isNaN(n) || suit === undefined) {
    return 0;
  }
  if (n === 0) {
    return 50 + suit; // aka five
  }
  return suit * 10 + n;
}

/** Non-aka version of a tenhou tile code (51 → 15). */
function deaka(t: number): number {
  if (Math.trunc(t / 10) === 5) {
    return 10 * (t % 10) + Math.trunc(t / 10);
  }
  return t;
}

/** Aka version of a tenhou tile code (15 → 51 if it's a 5). */
function makeaka(t: number): number {
  if (t % 10 === 5) {
    return 10 * (t % 10) + Math.trunc(t / 10);
  }
  return t;
}

/** seat0 relative to seat1: 0 = kamicha (prev), 1 = toimen, 2 = shimocha (next). */
function relativeSeating(self: number, other: number): number {
  return (self - other + 4 - 1) % 4;
}

// ---------------------------------------------------------------------------
// Pao tracking — daisangen / daisuushi liability.
// ---------------------------------------------------------------------------

const WINDS = [41, 42, 43, 44]; // 1z..4z
const DRAGS = [45, 46, 47]; // 5z..7z (haku/hatsu/chun)

// ---------------------------------------------------------------------------
// Per-round mutable state.
// ---------------------------------------------------------------------------

class Kyoku {
  // [4·chang + ju, honba, riichiSticks]
  round: [number, number, number] = [0, 0, 0];
  initScores: [number, number, number, number] = [0, 0, 0, 0];
  doras: number[] = [];
  uras: number[] = [];
  /** Hand at start, after popping the dealer's 14th tile into draws[dealer]. */
  haipais: number[][] = [[], [], [], []];
  draws: Array<Array<number | string>> = [[], [], [], []];
  discards: Array<Array<number | string>> = [[], [], [], []];

  /** Last discarder seat (for relative-seat encoding of calls). */
  ldseat = -1;
  /** Last tile we put on the discard row (the would-be popped tile for the
   *  dealer's first turn; otherwise the actual discard). */
  lastDiscardTile = -1;
  /** Pending riichi flag — flipped on by a riichi discard, off again when the
   *  hand ends or the riichi succeeds. We don't currently need to count
   *  successful riichis (delta comes from the platform), but we do need to
   *  remember that the most recent discard was the riichi tile so its
   *  string form has the `r` prefix. */
  // (handled inline)

  /** Per-seat triplet counters for pao detection. */
  nowinds = [0, 0, 0, 0];
  nodrags = [0, 0, 0, 0];
  paowind = -1;
  paodrag = -1;

  /** Collected wins (multi-ron supported); flushed on hand_end. */
  agaris: Array<{
    winner: number;
    from: number;
    delta: number[];
    han?: number;
    fu?: number;
    ten?: number;
    yakumanCount?: number;
    yaku?: Record<string, string>;
    uras: number[];
  }> = [];

  dump(): unknown[] {
    const entry: unknown[] = [
      this.round,
      this.initScores,
      this.doras,
      this.uras,
    ];
    for (let i = 0; i < 4; i++) {
      entry.push(this.haipais[i]);
      entry.push(this.draws[i]);
      entry.push(this.discards[i]);
    }
    return entry;
  }

  countPao(t: number, owner: number, feeder: number): void {
    const d = deaka(t);
    if (WINDS.includes(d)) {
      this.nowinds[owner] += 1;
      if (this.nowinds[owner] === 4) {
        this.paowind = feeder;
      }
    } else if (DRAGS.includes(d)) {
      this.nodrags[owner] += 1;
      if (this.nodrags[owner] === 3) {
        this.paodrag = feeder;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Round init from a `hand_start` event.
// ---------------------------------------------------------------------------

function initKyoku(
  k: Kyoku,
  ev: Extract<GameEvent, { type: "hand_start" }>
): void {
  // `round` (kyoku index) = 4·chang + ju where chang = wind index (0=E),
  // ju = dealer seat for the wind. The protocol gives us roundWind +
  // roundNumber (1-indexed), or falls back to `round + dealer` for
  // older logs. Prefer the explicit wind / number form when present.
  let chang = 0;
  if (ev.roundWind) {
    const wind = ev.roundWind;
    chang = wind === "E" ? 0 : wind === "S" ? 1 : wind === "W" ? 2 : 3;
  }
  const ju = ev.dealer ?? 0;
  k.round = [4 * chang + ju, ev.honba ?? 0, ev.riichiSticks ?? 0];

  const scores = ev.scores ?? [0, 0, 0, 0];
  k.initScores = [
    scores[0] ?? 0,
    scores[1] ?? 0,
    scores[2] ?? 0,
    scores[3] ?? 0,
  ];

  k.doras = (ev.doraIndicators ?? []).map(tile);
  k.uras = [];

  k.haipais = [[], [], [], []];
  k.draws = [[], [], [], []];
  k.discards = [[], [], [], []];

  const starting = ev.startingHands;
  if (starting) {
    for (let s = 0; s < 4; s++) {
      k.haipais[s] = (starting[s] ?? []).map(tile);
    }
  }

  // Dealer's 14th tile lives at the end of `haipais[dealer]`; promote it
  // to the first draw so tenhou's "13-tile starting hand + first draw"
  // contract holds.
  const popped = k.haipais[ju].pop();
  if (popped !== undefined) {
    k.draws[ju].push(popped);
  }

  k.ldseat = -1;
  k.lastDiscardTile = -1;
  k.nowinds = [0, 0, 0, 0];
  k.nodrags = [0, 0, 0, 0];
  k.paowind = -1;
  k.paodrag = -1;
  k.agaris = [];
}

// ---------------------------------------------------------------------------
// Call encoding.
// ---------------------------------------------------------------------------

function encodeCall(k: Kyoku, seat: number, meld: Meld): void {
  const meldTiles = meld.tiles.map(tile);
  const claimed =
    meld.claimedTile !== null && meld.claimedTile !== undefined
      ? tile(meld.claimedTile)
      : -1;

  switch (meld.type) {
    case "chi": {
      // Chi is only ever from kamicha; tenhou format always puts the
      // called tile first prefixed by 'c'.
      const own = meldTiles.filter((t: number) => t !== claimed);
      // Restore an "own" pair of two tiles (claimed could equal an own
      // tile if encoder dedup'd — fall back to the original ordering).
      while (own.length < 2 && meldTiles.length >= 3) {
        // Best-effort: take from the original meldTiles minus the first
        // occurrence of claimed.
        const copy = meldTiles.slice();
        const idx = copy.indexOf(claimed);
        if (idx >= 0) {
          copy.splice(idx, 1);
        }
        own.length = 0;
        own.push(...copy);
        break;
      }
      k.draws[seat].push(`c${claimed}${own[0] ?? 0}${own[1] ?? 0}`);
      return;
    }
    case "pon": {
      const own = meldTiles.filter((t: number) => t !== claimed);
      const idx =
        meld.from !== null && meld.from !== undefined
          ? relativeSeating(seat, meld.from)
          : 0;
      k.countPao(claimed, seat, meld.from ?? -1);
      const pieces: Array<number | string> = [own[0] ?? 0, own[1] ?? 0];
      pieces.splice(idx, 0, `p${claimed}`);
      k.draws[seat].push(pieces.join(""));
      return;
    }
    case "daiminkan": {
      const own = meldTiles.filter((t: number) => t !== claimed);
      const idx =
        meld.from !== null && meld.from !== undefined
          ? relativeSeating(seat, meld.from)
          : 0;
      k.countPao(claimed, seat, meld.from ?? -1);
      const insertAt = idx === 2 ? 3 : idx;
      const pieces: Array<number | string> = [
        own[0] ?? 0,
        own[1] ?? 0,
        own[2] ?? 0,
      ];
      pieces.splice(insertAt, 0, `m${claimed}`);
      k.draws[seat].push(pieces.join(""));
      // Tenhou follows a daiminkan with a `0` in the caller's discards.
      k.discards[seat].push(0);
      return;
    }
    case "ankan": {
      // Self-call from hand; goes in discards as "{t1}{t2}{t3}a{t4}".
      const tiles = meldTiles.slice();
      if (tiles.length < 4) {
        // Best-effort fallback.
        while (tiles.length < 4) {
          tiles.push(0);
        }
      }
      k.countPao(tiles[0], seat, -1);
      const last = tiles.pop() as number;
      k.discards[seat].push(tiles.join("") + "a" + last);
      return;
    }
    case "shouminkan": {
      // Rewrite the prior pon in `draws[seat]` by injecting the added
      // tile right after the `p`. The added tile is the one in meld.tiles
      // that wasn't part of the original pon — we approximate with
      // `claimedTile` when the encoder provides it, otherwise fall back
      // to the last tile of `meld.tiles`.
      const added = claimed !== -1 ? claimed : (meldTiles[3] ?? 0);
      const target = k.draws[seat].find(
        (w): w is string =>
          typeof w === "string" &&
          (w.includes("p" + deaka(added)) || w.includes("p" + makeaka(added)))
      );
      if (target) {
        const idx = k.draws[seat].indexOf(target);
        if (idx >= 0) {
          k.draws[seat][idx] = target.replace(/p/, "k" + added);
        }
      } else {
        // Couldn't find the prior pon — emit a defensive ankan-like
        // entry so the viewer at least sees the kan.
        k.discards[seat].push(`k${added}`);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Result encoding.
// ---------------------------------------------------------------------------

function formatScoreText(
  a: Kyoku["agaris"][number],
  isDealer: boolean
): string {
  // Tenhou's score-text contract is e.g. "30符2飜2000点" (ron) or
  // "30符2飜500-1000点" (tsumo, ko/oya). We only have flat `ten`,
  // so fall back to "<fu>符<han>飜<ten>点" for both. Yakuman uses
  // "役満<ten>点" — we follow the same simplification.
  const fu = a.fu ?? 0;
  const han = a.han ?? 0;
  const ten = a.ten ?? 0;
  if ((a.yakumanCount ?? 0) > 0 || han >= 13) {
    return `${a.yakumanCount && a.yakumanCount > 1 ? a.yakumanCount + "倍" : ""}役満${ten}点${isDealer && a.winner === a.from ? "∀" : ""}`;
  }
  return `${fu}符${han}飜${ten}点${isDealer && a.winner === a.from ? "∀" : ""}`;
}

function buildAgariEntry(
  k: Kyoku,
  a: Kyoku["agaris"][number],
  dealerSeat: number
): Array<number | string> {
  const pao =
    deaka(0) === 0 // (just to silence unused-import linters); replaced below
      ? -1
      : -1;
  // Pao seat: if the win contains a yakuman that's daisangen/daisuushi
  // we'd attach `paodrag` / `paowind`. The platform doesn't tell us
  // which yakuman it was, so we attach pao when *either* counter has
  // a feeder seat — at most one yakuman of each can complete in a
  // single hand, so over-attribution is bounded.
  let liable = pao;
  if (k.paowind !== -1 && a.yaku) {
    if (Object.keys(a.yaku).some((y) => /大四喜|daisuushi/i.test(y))) {
      liable = k.paowind;
    }
  }
  if (liable === -1 && k.paodrag !== -1 && a.yaku) {
    if (Object.keys(a.yaku).some((y) => /大三元|daisangen/i.test(y))) {
      liable = k.paodrag;
    }
  }

  const isDealer = a.winner === dealerSeat;
  const res: Array<number | string> = [
    a.winner,
    a.from,
    liable === -1 ? a.winner : liable,
    formatScoreText(a, isDealer),
  ];
  if (a.yaku) {
    for (const [name, han] of Object.entries(a.yaku)) {
      // han string is already "X飜" / "役満" — wrap in (han) for tenhou.
      res.push(`${name}(${han})`);
    }
  }
  return res;
}

function buildResult(
  k: Kyoku,
  end: Extract<GameEvent, { type: "hand_end" }> | null,
  dealerSeat: number
): unknown[] {
  // Wins take precedence over the hand_end reason — multi-ron flattens
  // every collected agari into a single ["和了", delta, agari, …] tuple.
  if (k.agaris.length > 0) {
    const out: Array<unknown> = ["和了"];
    for (const a of k.agaris) {
      const delta = a.delta.length === 4 ? a.delta.slice() : [0, 0, 0, 0];
      out.push(delta);
      out.push(buildAgariEntry(k, a, dealerSeat));
    }
    return out;
  }

  if (!end) {
    return ["流局", [0, 0, 0, 0]];
  }

  const delta =
    end.delta && end.delta.length === 4 ? end.delta.slice() : [0, 0, 0, 0];

  if (end.reason === "exhaustive_draw") {
    if (end.nagashi && end.nagashi.some(Boolean)) {
      return ["流し満貫", delta];
    }
    return ["流局", delta];
  }
  if (end.reason === "abort") {
    switch (end.abortKind) {
      case "kyuushuu":
        return ["九種九牌"];
      case "suufon_renda":
        return ["四風連打"];
      case "suucha_riichi":
        return ["四家立直"];
      case "sanchahou":
        return ["三家和"];
      default:
        // Best-effort fallback for abortive draws our protocol doesn't
        // tag explicitly (e.g. suukaikan).
        return ["四開槓"];
    }
  }
  // ron/tsumo without an explicit WinEvent — shouldn't happen but
  // emit a draw-shaped placeholder so the viewer still renders.
  return ["流局", delta];
}

// ---------------------------------------------------------------------------
// Top-level convert.
// ---------------------------------------------------------------------------

export function replayLogToTenhou5Json(replay: ReplayLog): Tenhou5Json {
  const name: [string, string, string, string] = ["", "", "", ""];
  for (const seat of replay.seats) {
    if (seat.seat >= 0 && seat.seat < 4) {
      name[seat.seat] = seat.displayName ?? "";
    }
  }

  const log: unknown[] = [];

  let k: Kyoku | null = null;
  let dealerSeat = 0;

  const flush = (end: Extract<GameEvent, { type: "hand_end" }> | null) => {
    if (!k) {
      return;
    }
    const entry = k.dump();
    entry.push(buildResult(k, end, dealerSeat));
    log.push(entry);
    k = null;
  };

  for (const ev of replay.events) {
    switch (ev.type) {
      case "hand_start": {
        // Implicit flush in case the previous hand never received a
        // hand_end (defensive).
        if (k) {
          flush(null);
        }
        k = new Kyoku();
        dealerSeat = ev.dealer ?? 0;
        initKyoku(k, ev);
        break;
      }

      case "draw": {
        if (!k || ev.tile === undefined) {
          break;
        }
        k.draws[ev.seat].push(tile(ev.tile));
        break;
      }

      case "discard": {
        if (!k) {
          break;
        }
        const sym = ev.tsumogiri ? TSUMOGIRI : tile(ev.tile);
        const display = ev.riichi ? "r" + sym : sym;
        k.discards[ev.seat].push(display);
        k.ldseat = ev.seat;
        k.lastDiscardTile = tile(ev.tile);
        break;
      }

      case "call": {
        if (!k) {
          break;
        }
        encodeCall(k, ev.seat, ev.meld);
        // For chi/pon/daiminkan the caller now "owns the turn" — their
        // next discard's `ldseat` will be themselves; ankan/shouminkan
        // keep `ldseat` as is (it represents who fed the last tile).
        if (
          ev.meld.type === "chi" ||
          ev.meld.type === "pon" ||
          ev.meld.type === "daiminkan"
        ) {
          k.ldseat = ev.seat;
        }
        break;
      }

      case "new_dora": {
        if (!k) {
          break;
        }
        k.doras.push(tile(ev.indicator));
        break;
      }

      case "win": {
        if (!k) {
          break;
        }
        // Capture ura dora once (multi-ron shares them).
        if (k.uras.length === 0 && ev.uraDoraIndicators) {
          k.uras = ev.uraDoraIndicators.map(tile);
        }
        const from =
          ev.loser !== null && ev.loser !== undefined ? ev.loser : ev.seat;
        k.agaris.push({
          winner: ev.seat,
          from,
          delta: (ev.delta ?? [0, 0, 0, 0]).slice(),
          han: ev.han,
          fu: ev.fu,
          ten: ev.ten,
          yakumanCount: ev.yakumanCount,
          yaku: ev.yaku,
          uras: k.uras,
        });
        break;
      }

      case "hand_end": {
        flush(ev);
        break;
      }

      default:
        // Other events (match_start/end, furiten, buu_*, session_*,
        // sinking_update) carry no per-round paipu data we encode.
        break;
    }
  }
  // Tail-flush a dangling hand if the log ends without an explicit
  // hand_end (rare; mostly old / corrupted logs).
  if (k) {
    flush(null);
  }

  // Title: human-readable summary at the top of the viewer.
  const startedAt = new Date(replay.startedAt || 0).toUTCString();
  const ruleLabel = replay.ruleSet || replay.source;

  // Red-fives: most platforms enable them; trust the ruleSetDetails
  // flag when present, otherwise default to 1 (the common case).
  const akaFromDetails = (() => {
    const d = replay.ruleSetDetails;
    if (!d || typeof d !== "object") {
      return undefined;
    }
    const v =
      (d as Record<string, unknown>).aka ??
      (d as Record<string, unknown>).redFives ??
      (d as Record<string, unknown>).hasAka;
    if (typeof v === "boolean") {
      return v ? 1 : 0;
    }
    if (typeof v === "number") {
      return v > 0 ? 1 : 0;
    }
    return undefined;
  })();

  return {
    title: [`${ruleLabel} (${replay.source})`, startedAt],
    name,
    rule: { aka: akaFromDetails ?? 1 },
    log,
  };
}

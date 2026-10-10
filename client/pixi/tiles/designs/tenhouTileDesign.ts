/**
 * Tenhou tile design — the current production artwork and metrics,
 * lifted verbatim from the constants previously inlined in
 * `TableRenderer`. Values here are the visual baseline; changing them
 * changes what ships. See `tileDesign.ts` for the contract.
 */
import ownHandUrl from "~/game/tenhouSprites/ownHand.png";
import bottomSmallUrl from "~/game/tenhouSprites/bottomSmall.png";
import topSmallUrl from "~/game/tenhouSprites/topSmall.png";
import leftSmallUrl from "~/game/tenhouSprites/leftSmall.png";
import rightSmallUrl from "~/game/tenhouSprites/rightSmall.png";
import sideHandLUrl from "~/game/tenhouSprites/uprightSideHandL.png";
import sideHandRUrl from "~/game/tenhouSprites/uprightSideHandR.png";
import uprightBigUrl from "~/game/tenhouSprites/shadowTenhouUprightBig.png";
import uprightSmallUrl from "~/game/tenhouSprites/shadowTenhouUprightSmall.png";
import shadowTopBottomUrl from "~/game/tenhouSprites/shadowTenhouTopBottom.png";
import shadowLeftRightUrl from "~/game/tenhouSprites/shadowTenhouLeftRight.png";
import shadowLongUrl from "~/game/tenhouSprites/shadowTenhouLong.png";
import mcrOwnHandUrl from "~/game/mcrSprites/mcrEngravedOwnHand.png";
import mcrBottomSmallUrl from "~/game/mcrSprites/mcrEngravedBottomSmall.png";
import mcrTopSmallUrl from "~/game/mcrSprites/mcrEngravedTopSmall.png";
import mcrLeftSmallUrl from "~/game/mcrSprites/mcrEngravedLeftSmall.png";
import mcrRightSmallUrl from "~/game/mcrSprites/mcrEngravedRightSmall.png";
import type { GridAtlas, TileDesign } from "../tileDesign";

/** Small/side tiles render at half size, trimmed by 9.4% so the
 * artwork's baked margin doesn't read as oversized on the felt. */
const SMALL_SIDE_SCALE = 0.5 * (1 - 0.094);
/** The focused hand's large tiles use a slightly-over-half scale. */
const BIG_SCALE = 0.51;
/** Left/right wall stack: fixed screen width and the source art's
 * height/width aspect (107 × 116 px cell). */
const WALL_SIDE_ASPECT = 107 / 116;

const SUIT_ROWS = { m: 0, p: 1, s: 2, z: 3 } as const;

/** Shared shape for the five original Tenhou 10×4 grid sheets. */
function grid(url: string): GridAtlas {
  return {
    kind: "grid",
    url,
    cols: 10,
    rows: 4,
    suitRows: { ...SUIT_ROWS },
    backCell: { row: 3, col: 0 },
    inset: 0.5,
  };
}

function mcrGrid(url: string): GridAtlas {
  return {
    ...grid(url),
    rows: 5,
    suitRows: { ...SUIT_ROWS, f: 4 },
    supportedSuits: ["m", "p", "s", "z", "f"],
  };
}

export const tenhouTileDesign: TileDesign = {
  id: "tenhou",
  displayName: "Tenhou",
  attribution:
    "MCR face artwork derived from samoheen/mahjong-tiles (Public Domain)",
  atlases: {
    mcrOwnHand: mcrGrid(mcrOwnHandUrl),
    mcrBottomSmall: mcrGrid(mcrBottomSmallUrl),
    mcrTopSmall: mcrGrid(mcrTopSmallUrl),
    mcrLeftSmall: mcrGrid(mcrLeftSmallUrl),
    mcrRightSmall: mcrGrid(mcrRightSmallUrl),
    ownHand: grid(ownHandUrl),
    bottomSmall: grid(bottomSmallUrl),
    topSmall: grid(topSmallUrl),
    leftSmall: grid(leftSmallUrl),
    rightSmall: grid(rightSmallUrl),
    sideHandL: { kind: "single", url: sideHandLUrl },
    sideHandR: { kind: "single", url: sideHandRUrl },
    uprightBig: { kind: "single", url: uprightBigUrl },
    uprightSmall: { kind: "single", url: uprightSmallUrl },
    shadowTopBottom: { kind: "single", url: shadowTopBottomUrl },
    shadowLeftRight: { kind: "single", url: shadowLeftRightUrl },
    shadowLong: { kind: "single", url: shadowLongUrl },
  },
  mcrAtlasOverrides: {
    ownHand: "mcrOwnHand",
    bottomSmall: "mcrBottomSmall",
    topSmall: "mcrTopSmall",
    leftSmall: "mcrLeftSmall",
    rightSmall: "mcrRightSmall",
  },
  categories: {
    small: { source: { w: 86, h: 130 }, scale: SMALL_SIDE_SCALE },
    side: { source: { w: 116, h: 107 }, scale: SMALL_SIDE_SCALE },
    big: { source: { w: 131, h: 198 }, scale: BIG_SCALE },
  },
  sheets: {
    ownHand: "ownHand",
    ownHandBack: "bottomSmall",
    resultHandBack: {
      0: "bottomSmall",
      1: "rightSmall",
      2: "bottomSmall",
      3: "rightSmall",
    },
    topHand: "topSmall",
    sideHandBack: { 1: "sideHandR", 3: "sideHandL" },
    sideHandFace: { 1: "rightSmall", 3: "leftSmall" },
    discard: {
      0: "bottomSmall",
      1: "rightSmall",
      2: "topSmall",
      3: "leftSmall",
    },
    riichiDiscard: {
      0: "leftSmall",
      1: "bottomSmall",
      2: "leftSmall",
      3: "topSmall",
    },
    wallBack: {
      0: "bottomSmall",
      1: "rightSmall",
      2: "bottomSmall",
      3: "rightSmall",
    },
    wallFace: {
      0: "bottomSmall",
      1: "rightSmall",
      2: "topSmall",
      3: "leftSmall",
    },
    meld: { 0: "bottomSmall", 1: "rightSmall", 2: "topSmall", 3: "leftSmall" },
    meldFaceDown: {
      0: "bottomSmall",
      1: "rightSmall",
      2: "bottomSmall",
      3: "rightSmall",
    },
  },
  spacing: {
    discardRowHoriz: 14.5,
    discardRowVert: 15,
    sideHand: 30,
    wallSide: 16,
    meldSide: 16,
    tsumoGap: 8,
  },
  metrics: {
    sideHandBack: { w: 29, h: 65 },
    topHand: { w: 41, h: 63 },
    wallUpright: { w: 41, h: 63 },
    wallSide: { screenW: 57, aspect: WALL_SIDE_ASPECT },
    discardUprightBump: 3,
  },
  effects: {
    tsumogiriFreshTint: 0xc8c8c8,
    tsumogiriFreshWindow: 3,
    waitTint: 0xff5555,
    shadow: {
      small: "shadowTopBottom",
      side: "shadowLeftRight",
      big: "uprightBig",
      uprightSmall: "uprightSmall",
      long: "shadowLong",
      depth: 14,
      cap: 0.15,
      uprightScale: 0.34,
      offsetX: -3,
      offsetY: -3,
    },
  },
};

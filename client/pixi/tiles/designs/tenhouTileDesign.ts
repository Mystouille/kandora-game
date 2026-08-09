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

/** Shared shape for the five 10×4 grid sheets. */
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

export const tenhouTileDesign: TileDesign = {
  id: "tenhou",
  displayName: "Tenhou",
  atlases: {
    ownHand: grid(ownHandUrl),
    bottomSmall: grid(bottomSmallUrl),
    topSmall: grid(topSmallUrl),
    leftSmall: grid(leftSmallUrl),
    rightSmall: grid(rightSmallUrl),
    sideHandL: { kind: "single", url: sideHandLUrl },
    sideHandR: { kind: "single", url: sideHandRUrl },
  },
  categories: {
    small: { source: { w: 86, h: 130 }, scale: SMALL_SIDE_SCALE },
    side: { source: { w: 116, h: 107 }, scale: SMALL_SIDE_SCALE },
    big: { source: { w: 131, h: 198 }, scale: BIG_SCALE },
  },
  sheets: {
    ownHand: "ownHand",
    topHand: "topSmall",
    sideHandBack: { 1: "sideHandR", 3: "sideHandL" },
    sideHandFace: { 1: "rightSmall", 3: "leftSmall" },
    discard: { 0: "bottomSmall", 1: "rightSmall", 2: "topSmall", 3: "leftSmall" },
    riichiDiscard: {
      0: "leftSmall",
      1: "bottomSmall",
      2: "leftSmall",
      3: "topSmall",
    },
    wallBack: { 0: "bottomSmall", 1: "rightSmall", 2: "bottomSmall", 3: "rightSmall" },
    wallFace: { 0: "bottomSmall", 1: "rightSmall", 2: "topSmall", 3: "leftSmall" },
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
  },
};

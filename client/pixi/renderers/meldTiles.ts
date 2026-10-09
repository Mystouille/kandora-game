import { Container, Sprite } from "pixi.js";
import type { Meld } from "~/game/protocol/messages";
import type { Seat } from "../tableGeometry";
import type { RenderResources } from "../scene/renderTypes";
import type {
  MeldDrawingPort,
  MeldSheetKey as SheetKey,
} from "../results/resultTypes";
import { meldTileDims } from "../tileAreaLayout";
import { ankanTilesForDisplay, tileSortKey } from "../geometry/tileOrder";
import { DISCARD_ROW_OVERLAP_HORIZ } from "../geometry/renderConstants";
import { tintIfWait } from "./tileTint";

export class MeldTileRenderer implements MeldDrawingPort {
  constructor(
    private readonly resources: RenderResources,
    private readonly waitTiles: ReadonlySet<string>
  ) {}

  drawMeld(
    meld: Meld,
    seat: number,
    shouminkanOffsetY = 0,
    revealAnkan = false
  ): {
    node: Container;
    width: number;
    boxes: Array<{
      cx: number;
      cy: number;
      w: number;
      h: number;
      isolated?: boolean;
    }>;
  } {
    const c = new Container();
    c.sortableChildren = true;
    const boxes: Array<{
      cx: number;
      cy: number;
      w: number;
      h: number;
      isolated?: boolean;
    }> = [];
    // Side-seat melds overlap consecutive tiles by 16 design pixels
    // along the row direction, matching the discard pond. Bottom/top
    // seats butt their tiles flush with no gap.
    const meldOverlap = seat === 1 || seat === 3 ? 16 : 0;
    // Within-strip z-order for side seats: the tile lower on
    // screen sits on top of its neighbour, matching discards.
    //   Seat 1 (right, container rot -π/2): cursor +x → screen -y,
    //     so smaller i is lower on screen → zIndex = -i.
    //   Seat 3 (left, container rot +π/2): cursor +x → screen +y,
    //     so larger i is lower on screen → zIndex = i.
    const tileZ = (i: number): number => {
      if (seat === 1) {
        return -i;
      }
      if (seat === 3) {
        return i;
      }
      return 0;
    };
    if (meld.type === "ankan") {
      const tiles: Array<string | null> =
        meld.tiles.length === 0
          ? [null, null, null, null]
          : ankanTilesForDisplay(meld.tiles);
      let ax = 0;
      const mt = meldTileDims(this.resources.tileDesign, seat);
      tiles.forEach((tile, i) => {
        const faceUp =
          tile !== null &&
          (revealAnkan || !(i === 0 || i === tiles.length - 1));
        const {
          node: sprite,
          offX,
          offY,
          footW,
          footH,
        } = faceUp
          ? this.drawMeldTile(tile, seat)
          : this.drawMeldTile(null, seat);
        sprite.position.set(ax, 0);
        sprite.zIndex = tileZ(i);
        ax += mt.w - meldOverlap;
        c.addChild(sprite);
        boxes.push({
          cx: sprite.position.x + offX,
          cy: sprite.position.y + offY,
          w: footW,
          h: footH,
        });
      });
      return {
        node: c,
        width: tiles.length * mt.w - (tiles.length - 1) * meldOverlap,
        boxes,
      };
    }
    if (meld.claimedTile === null || meld.from === null) {
      // Shouldn't happen for chi/pon/kan, but render defensively as a
      // plain row.
      let dx = 0;
      const mt = meldTileDims(this.resources.tileDesign, seat);
      meld.tiles.forEach((tile, i) => {
        const {
          node: sprite,
          offX,
          offY,
          footW,
          footH,
        } = this.drawMeldTile(tile, seat);
        sprite.position.set(dx, 0);
        sprite.zIndex = tileZ(i);
        dx += mt.w - meldOverlap;
        c.addChild(sprite);
        boxes.push({
          cx: sprite.position.x + offX,
          cy: sprite.position.y + offY,
          w: footW,
          h: footH,
        });
      });
      return {
        node: c,
        width: meld.tiles.length * mt.w - (meld.tiles.length - 1) * meldOverlap,
        boxes,
      };
    }

    // Build the visible tile sequence: non-called tiles in tile-sort
    // order, then insert the called tile at the slot indicated by
    // `from` direction.
    const called = meld.claimedTile;
    // For shouminkan we render the original three pon tiles in the
    // row and stack the upgrade tile on top of the called slot.
    const isShouminkan = meld.type === "shouminkan";
    // Remove a SINGLE copy of the called tile (pon/kan of identical
    // tiles like "1m,1m,1m" would otherwise filter every match and
    // leave `otherTiles` empty → undefined slot tiles → crash).
    const otherTiles = (() => {
      const rest = [...meld.tiles];
      const idx = rest.indexOf(called);
      if (idx >= 0) {
        rest.splice(idx, 1);
      }
      return rest.sort((a, b) => tileSortKey(a) - tileSortKey(b));
    })();
    // For shouminkan there are 4 matching tiles in `meld.tiles`; the
    // base row is 3 tiles (called + 2 others), and the 4th tile goes
    // on top of the called.
    let baseOthers = otherTiles;
    let stackTile: string | null = null;
    if (isShouminkan && otherTiles.length === 3) {
      // The "extra" tile is whichever copy isn't the called tile and
      // doesn't appear in the original pon. We can't reliably tell
      // them apart by string (red 5 aside), so just lift the last
      // copy onto the stack.
      baseOthers = otherTiles.slice(0, 2);
      stackTile = otherTiles[2];
    }

    // From-direction → called tile slot in the base row of length 3:
    //   prev  (kamicha)  → 0 (left)
    //   across (toimen)  → 1 (middle)
    //   next  (shimocha) → 2 (right)
    const calledSlot3 =
      meld.from === (seat + 3) % 4 ? 0 : meld.from === (seat + 2) % 4 ? 1 : 2;

    // Layout: walk slots in screen order. Chi / pon = 3 slots,
    // daiminkan / shouminkan base row = 3 slots (the 4th tile is
    // either irrelevant for chi/pon or stacked on top for shouminkan;
    // for daiminkan the 4th tile sits next to the called tile).
    const slotCount = meld.type === "daiminkan" ? 4 : 3;
    // Daiminkan extends to 4 slots; the called (tilted) tile must
    // still sit at the *edge* corresponding to the from-direction
    // (kamicha → leftmost = 0, shimocha → rightmost = 3) so the
    // rotated tile points outward at the discarder. The toimen
    // case keeps the middle convention but shifts to slot 1 so the
    // 4th non-called copy can sit to its right.
    const calledSlot =
      meld.type === "daiminkan" && calledSlot3 === 2 ? 3 : calledSlot3;
    const slots: Array<{ tile: string; rotated: boolean }> = [];
    let oi = 0;
    for (let s = 0; s < slotCount; s++) {
      if (s === calledSlot) {
        slots.push({ tile: called, rotated: true });
      } else {
        const t = baseOthers[oi++];
        if (t === undefined) {
          continue;
        }
        slots.push({ tile: t, rotated: false });
      }
    }
    let xCursor = 0;
    let calledX = 0;
    const mt = meldTileDims(this.resources.tileDesign, seat);
    // Tilted called tile uses the NEXT-CLOCKWISE seat's sheet so it
    // visually points outward toward the player from whom the tile
    // was claimed (Tenhou convention). Its size matches that
    // seat's discard dims (which may differ from the strip seat's
    // dims for side strips).
    const tiltedSheet = this.resources.tileDesign.sheets.meld[
      ((seat + 1) % 4) as Seat
    ] as SheetKey;
    const tiltedSeat = (seat + 1) % 4;
    const tilted = meldTileDims(this.resources.tileDesign, tiltedSeat);
    slots.forEach((slot, i) => {
      const {
        node: sprite,
        offX,
        offY,
        footW,
        footH,
      } = slot.rotated
        ? this.drawMeldTile(slot.tile, seat, tiltedSheet)
        : this.drawMeldTile(slot.tile, seat);
      sprite.zIndex = tileZ(i);
      if (slot.rotated) {
        sprite.rotation = -Math.PI / 2;
        // After -90° rotation around (0,0), the sprite occupies
        // x∈[0, tilted.h], y∈[-tilted.w, 0]. Shift it so it sits
        // flush with the bottom of the row (y = mt.h) at the
        // current x cursor.
        sprite.position.set(xCursor, mt.h);
        calledX = xCursor;
        xCursor += tilted.h - meldOverlap;
      } else {
        sprite.position.set(xCursor, 0);
        xCursor += mt.w - meldOverlap;
      }
      c.addChild(sprite);
      boxes.push({
        cx: sprite.position.x + offX,
        cy: sprite.position.y + offY,
        w: footW,
        h: footH,
        isolated: slot.rotated,
      });
    });
    if (stackTile !== null) {
      const {
        node: stack,
        offX: stackOffX,
        offY: stackOffY,
        footW: stackFootW,
        footH: stackFootH,
      } = this.drawMeldTile(stackTile, seat, tiltedSheet);
      stack.rotation = -Math.PI / 2;
      // Z-order:
      //   - Bottom seat (0): stack renders UNDER the called tile so
      //     the called tile's top edge occludes the small overlap
      //     band, giving a subtle depth cue.
      //   - Top seat (2): the meld container is rotated 180°, which
      //     visually flips what is "under" into "over" from the
      //     bottom-seat POV. To keep the same "added tile sits on
      //     top of the called tile" semantics, flip z-order so the
      //     stack draws OVER the called tile.
      //   - Side seats (1, 3): the stack sits at the same X as the
      //     called tile, so it overlaps the upright neighbour along
      //     the row exactly like the called tile does. Match the
      //     called tile's zIndex so the stack inherits the same
      //     overlap behavior (called in front of/behind neighbour
      //     per the side-strip discard rule).
      if (seat === 1 || seat === 3) {
        stack.zIndex = tileZ(calledSlot);
      } else {
        stack.zIndex =
          seat === 2 ? tileZ(slots.length) + 1 : tileZ(slots.length) - 1;
      }
      // Vertical offset: bottom/top seats overlap the called tile
      // by `DISCARD_ROW_OVERLAP_HORIZ` for a stacked-in-perspective
      // look. Side seats (1, 3) butt the stack flush against the
      // called tile with NO overlap — the tilted-tile silhouettes
      // are already very close to the row edge and any overlap
      // reads as a glitch from a side perspective.
      const stackOverlap =
        seat === 1 || seat === 3 ? 0 : DISCARD_ROW_OVERLAP_HORIZ;
      stack.position.set(
        calledX,
        mt.h - tilted.w + stackOverlap + shouminkanOffsetY
      );
      c.addChild(stack);
      boxes.push({
        cx: stack.position.x + stackOffX,
        cy: stack.position.y + stackOffY,
        w: stackFootW,
        h: stackFootH,
        isolated: true,
      });
    }
    // Total footprint width = xCursor (sum of strides) + the last
    // tile's full width restored (each stride subtracted `meldOverlap`,
    // but there is no next tile to overlap with the last one).
    return { node: c, width: xCursor + meldOverlap, boxes };
  }

  drawMeldTile(
    tile: string | null,
    seat: number,
    sheetOverride?: SheetKey
  ): {
    node: Container;
    offX: number;
    offY: number;
    footW: number;
    footH: number;
  } {
    // When using an override sheet (tilted called tile), size the
    // tile to match the override-seat's discard dimensions so the
    // sprite preserves its source proportions.
    const sheetSeatBySheet: Record<SheetKey, number> = {
      bottomSmall: 0,
      rightSmall: 1,
      topSmall: 2,
      leftSmall: 3,
      ownHand: 0,
      sideHandL: 3,
      sideHandR: 1,
    };
    const dimsSeat = sheetOverride ? sheetSeatBySheet[sheetOverride] : seat;
    const dims = meldTileDims(this.resources.tileDesign, dimsSeat);
    // Sheets come from the active design; face-down (ankan outer)
    // tiles read the back-sheet map. Casts are safe: the design's
    // atlas ids are exactly the legacy sheet keys.
    const sheet =
      sheetOverride ??
      ((tile === null
        ? this.resources.tileDesign.sheets.meldFaceDown[seat as Seat]
        : this.resources.tileDesign.sheets.meld[seat as Seat]) as SheetKey);
    const tex = this.resources.textureStore.getTexture(sheet, tile);
    const c = new Container();
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    tintIfWait(sprite, tile, this.waitTiles);
    // Counter-rotate the sprite by the strip's container rotation
    // so the per-seat pre-rotated source displays in its natural
    // orientation in screen space (just like discards). Pre-
    // rotation sprite dims are chosen so the post-rotation
    // footprint equals dims.w × dims.h.
    const stripRot = [0, -Math.PI / 2, Math.PI, Math.PI / 2][seat];
    // Pre-rotation sprite dims must be chosen so that after the
    // total rotation the screen footprint equals dims.w × dims.h.
    // Without an override, total rotation = -stripRot (axes swap
    // for seats 1/3). With the tilted override we add an extra
    // +π/2, which flips which seats need the swap (seats 0/2).
    const swapAxes = sheetOverride
      ? seat === 0 || seat === 2
      : seat === 1 || seat === 3;
    if (swapAxes) {
      sprite.width = dims.h;
      sprite.height = dims.w;
    } else {
      sprite.width = dims.w;
      sprite.height = dims.h;
    }
    sprite.rotation = -stripRot + (sheetOverride ? Math.PI / 2 : 0);
    sprite.position.set(dims.w / 2, dims.h / 2);
    c.addChild(sprite);
    // Screen footprint + tile-centre offset (folding in the caller's
    // -90° tilt for called tiles) so the meld can bucket its tiles
    // into screen-columns for the shadow pass.
    const tiltRot = sheetOverride ? -Math.PI / 2 : 0;
    const tc = Math.cos(tiltRot);
    const tsin = Math.sin(tiltRot);
    return {
      node: c,
      offX: (dims.w / 2) * tc - (dims.h / 2) * tsin,
      offY: (dims.w / 2) * tsin + (dims.h / 2) * tc,
      footW: sprite.width,
      footH: sprite.height,
    };
  }
}

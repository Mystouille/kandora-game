import { Container } from "pixi.js";
import type { Seat } from "../tableGeometry";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import {
  MELD_SLIDE_TILE_WIDTHS,
  rotateMeldLocalPoint,
  type MeldAnimator,
} from "../meldAnimator";
import { meldTileDims } from "../tileAreaLayout";
import { focusedHandTileMetrics } from "../geometry/handGeometry";
import {
  layoutTouchingMeldColumn,
  layoutMeldStripGroups,
} from "../geometry/meldGeometry";
import { SEAT_CONTAINER_ROT, SMALL_TILE_H } from "../geometry/renderConstants";
import type { MeldDrawingPort } from "../results/resultTypes";
import type { HandSeatRender } from "./handRenderTypes";
import type { TileShadows } from "./tileShadows";

export class MeldRenderer {
  constructor(
    private readonly resources: RenderResources,
    private readonly meldAnimator: MeldAnimator,
    private readonly shadows: TileShadows
  ) {}

  render(
    frame: RenderFrame,
    seat: Seat,
    hand: HandSeatRender,
    drawer: MeldDrawingPort
  ): void {
    const {
      displayMelds: melds,
      handRect,
      longAxisOffset,
      handWidth,
      animateMelds: animate,
    } = hand;

    if (!frame.root || melds.length === 0) {
      return;
    }
    void longAxisOffset;
    void handWidth;
    // Adjacent melds overlap along the strip just like tiles
    // within a single meld: side seats overlap by 16 design px,
    // bottom/top butt flush.
    const meldGap = seat === 1 || seat === 3 ? -16 : 0;
    const strip = new Container();
    strip.label = `meld-seat-${seat}`;
    // Where adjacent melds overlap, the newer meld must render
    // on top of the older one (matching the discard-pond
    // convention that the most recent tile sits on top of its
    // neighbour). Enable z-sorting on the strip so we can stamp
    // each meld with a zIndex that mirrors its declaration order
    // regardless of the addChild sequence below.
    strip.sortableChildren = true;
    // Lay melds out so the FIRST call sits at the outer end of the
    // strip (player's-right end of the band) and subsequent calls
    // stack inward toward the hand. We render in reverse order
    // along local +x so the strip's leftmost tile (local x=0) is
    // the most recent call, and the rightmost tile is the first
    // call.
    const stripRot = SEAT_CONTAINER_ROT[seat];
    const built: Array<{
      index: number;
      node: Container;
      width: number;
      boxes: Array<{
        cx: number;
        cy: number;
        w: number;
        h: number;
        isolated?: boolean;
      }>;
      slideOffsetX: number;
      loopIter: number;
      perTileShadows: boolean;
    }> = [];
    let loopIter = 0;
    for (let i = melds.length - 1; i >= 0; i--) {
      const slideDistance =
        meldTileDims(this.resources.tileDesign, seat).w *
        MELD_SLIDE_TILE_WIDTHS;
      const slideOffsetX = animate
        ? this.meldAnimator.getMeldOffsetX(seat, i, slideDistance)
        : 0;
      const shouminkanOffsetY = animate
        ? this.meldAnimator.getShouminkanOffsetY(seat, i, slideDistance)
        : 0;
      const { node, width, boxes } = drawer.drawMeld(
        melds[i],
        seat,
        shouminkanOffsetY
      );
      built.push({
        index: i,
        node,
        width,
        boxes,
        slideOffsetX,
        loopIter,
        perTileShadows: seat === 3 && melds[i].type === "pon",
      });
      loopIter += 1;
    }

    const stackFourSideMelds =
      frame.presentation === "mobile" &&
      (seat === 1 || seat === 3) &&
      melds.length === 4;
    const groupBounds = built.map((group) => {
      const bounds = group.node.getLocalBounds();
      return { minY: bounds.minY, maxY: bounds.maxY };
    });
    const groupLayout = stackFourSideMelds
      ? layoutTouchingMeldColumn(
          built.map((group) => group.width),
          groupBounds
        )
      : layoutMeldStripGroups(
          built.map((group) => group.width),
          meldGap
        );
    const shadowBoxes: Array<{
      ax: number;
      ay: number;
      w: number;
      h: number;
      isolated?: boolean;
    }> = [];
    built.forEach((group, groupIndex) => {
      const placement = groupLayout.placements[groupIndex];
      group.node.position.set(placement.x + group.slideOffsetX, placement.y);
      for (const box of group.boxes) {
        const shadowPoint = rotateMeldLocalPoint(
          placement.x + group.slideOffsetX + box.cx,
          placement.y + box.cy,
          stripRot
        );
        shadowBoxes.push({
          ax: shadowPoint.x,
          ay: shadowPoint.y,
          w: box.w,
          h: box.h,
          isolated: group.perTileShadows || box.isolated,
        });
      }
      // Z-order between adjacent overlapping melds must match the
      // within-meld convention used in `drawMeld` (tile lower on
      // screen sits on top):
      //   Seat 1 (right, container rot -π/2): local +x → screen -y,
      //     so the meld at the LOWEST cursor is lowest on screen
      //     and should be on top → zIndex = -loopIter.
      //   Seat 3 (left,  container rot +π/2): local +x → screen +y,
      //     so the meld at the HIGHEST cursor is lowest on screen
      //     and should be on top → zIndex = +loopIter.
      //   Seats 0/2 don't overlap (meldGap = 0); any stable order
      //   works, fall back to declaration order.
      if (seat === 1) {
        group.node.zIndex = -group.loopIter;
      } else if (seat === 3) {
        group.node.zIndex = group.loopIter;
      } else {
        group.node.zIndex = group.index;
      }
      strip.addChild(group.node);
    });
    const stripWidth = groupLayout.width;
    // Anchor the strip so its right end (local +x = stripWidth)
    // aligns with the band's player-right edge. `longAxisLen` is
    // the band's length along the hand-container's local +x.
    const longAxisLen = seat % 2 === 0 ? handRect.w : handRect.h;
    const stripOriginLocalX = longAxisLen - stripWidth;
    // Place the strip's local origin so local +x=0 lies at band-
    // local-x = stripOriginLocalX. The four cases mirror the
    // hand-container's rotation / anchor scheme.
    switch (seat) {
      case 0: {
        // Bottom-align with the closed hand: the hand uses BIG
        // tiles (height BIG_TILE_H) while melds use SMALL tiles
        // (height SMALL_TILE_H). Both share `handRect.y` as their
        // top anchor; shift the meld strip down by the height
        // difference so their bottom edges coincide.
        strip.position.set(
          handRect.x + stripOriginLocalX,
          handRect.y +
            focusedHandTileMetrics(frame.layout, frame.presentation).spriteH -
            SMALL_TILE_H
        );
        break;
      }
      case 1: {
        strip.rotation = -Math.PI / 2;
        strip.position.set(
          handRect.x,
          handRect.y + handRect.h - stripOriginLocalX
        );
        break;
      }
      case 2: {
        strip.rotation = Math.PI;
        strip.position.set(
          handRect.x + handRect.w - stripOriginLocalX,
          handRect.y + handRect.h
        );
        break;
      }
      case 3: {
        strip.rotation = Math.PI / 2;
        strip.position.set(
          handRect.x + handRect.w,
          handRect.y + stripOriginLocalX
        );
        break;
      }
    }
    // Upright meld tiles may share a continuous screen-column shadow.
    // A left-seat pon uses per-tile shadows because a shared shadow for its
    // upright pair appears detached from the sideways called tile.
    // Other tilted called tiles remain isolated: for a left-seat call from
    // the right their centre can align with the upright column, causing the
    // sideways shadow to be incorrectly merged into the long strip.
    const shadowLayer = this.shadows.screenShadowLayer(strip, stripRot);
    const sharedShadowBoxes = shadowBoxes.filter((box) => !box.isolated);
    if (sharedShadowBoxes.length > 0) {
      this.shadows.placeColumnShadows(shadowLayer, sharedShadowBoxes);
    }
    for (const box of shadowBoxes.filter((candidate) => candidate.isolated)) {
      this.shadows.placeColumnShadows(shadowLayer, [box]);
    }
    frame.root.addChild(strip);
  }
}

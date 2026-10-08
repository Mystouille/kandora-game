import { Container, Graphics, type Sprite } from "pixi.js";
import type { Seat } from "../tableGeometry";
import type { TableLayout } from "../tableLayout";
import type {
  RenderFrame,
  RenderResources,
  TableRendererPresentation,
  TsumogiriTintMode,
} from "../scene/renderTypes";
import type { DiscardAnimator } from "../discardAnimator";
import {
  layoutDiscards,
  type DiscardLayoutOptions,
  type TilePlacement,
} from "../tileAreaLayout";
import { focusedHandTileMetrics } from "../geometry/handGeometry";
import {
  discardContainerZIndex,
  shouldTintTsumogiri,
} from "../geometry/tableGeometry";
import {
  riichiStickMetrics,
  mobileRiichiStickPlacement,
} from "../geometry/riichiGeometry";
import {
  TSUMO_GAP,
  SIDE_TILE_H,
  SIDE_TILE_W,
  DISCARD_ROW_OVERLAP_HORIZ,
  SEAT_CONTAINER_ROT,
  DISCARD_SHADOW_Z_INDEX,
  RIICHI_STICK_Z_INDEX,
  TSUMOGIRI_FRESH_TINT,
} from "../geometry/renderConstants";
import type { HandSeatRender } from "./handRenderTypes";
import type { TileShadows } from "./tileShadows";
import { tintIfWait } from "./tileTint";

export class DiscardRenderer {
  private tsumogiriTintMode: TsumogiriTintMode = "fresh";
  constructor(
    private readonly resources: RenderResources,
    private readonly animator: DiscardAnimator,
    private readonly shadows: TileShadows
  ) {}

  setShowTsumogiri(flag: boolean): void {
    this.tsumogiriTintMode = flag ? "all" : "none";
  }

  render(
    frame: RenderFrame,
    seat: Seat,
    state: HandSeatRender,
    options: DiscardLayoutOptions | undefined
  ): void {
    const { view, layout } = frame;
    const {
      handContainer,
      seatDiscardAnim,
      discardWaitingToStart,
      hand,
      isFreshlyDrawn,
      isSideHand,
      sideHandRevealed,
    } = state;
    const factory = this.resources.spriteFactory;
    const discards = view.discards[seat] ?? [];
    const tintTile = (sprite: Sprite, tile: string | null): boolean =>
      tintIfWait(sprite, tile, frame.waitTiles);

    // Discards as a 6-per-row pond. Rows overlap by
    // `DISCARD_ROW_OVERLAP` design pixels along the row-stacking
    // axis; the tile lower on screen sits on top of the one above
    // (mirrored for the top seat, whose pond is rotated 180°).
    // When this seat declared riichi, the tile at
    // `view.riichiTileIdx[seat]` is rotated 90° (SMALL_TILE_H wide ×
    // SMALL_TILE_W tall) — subsequent tiles in the SAME row shift right
    // by the extra width so they don't overlap.
    const discardContainer = new Container();
    discardContainer.label = `discard-seat-${seat}`;
    discardContainer.sortableChildren = true;
    discardContainer.zIndex = discardContainerZIndex(seat as Seat);
    const riichiIdx = view.riichiTileIdx[seat];
    // -----------------------------------------------------------------
    // Discard slide animation hookup. When this seat has an active
    // phase-A/B animation targeting the very last discard, we skip
    // painting its static wrap and reuse its placement for the overlay
    // below. Riichi declarations use the same motion; their placement
    // carries the sideways atlas / rotation through the overlay.
    // -----------------------------------------------------------------
    const lastIdx = discards.length - 1;
    const lastIsAnimating =
      seatDiscardAnim != null &&
      lastIdx >= 0 &&
      seatDiscardAnim.discardIndex === lastIdx;
    // Keep every discard shadow in a low-z root sibling. If settled
    // shadows inherited the pond's root zIndex while only flying
    // shadows moved here, they would switch sides of a riichi stick
    // at animation boundaries.
    const discardShadowHost = new Container();
    discardShadowHost.zIndex = DISCARD_SHADOW_Z_INDEX;
    discardShadowHost.sortableChildren = true;
    frame.root.addChild(discardShadowHost);
    // Lift the pond above the walls (zIndex 0..2) while a tile flies.
    if (lastIsAnimating) {
      discardContainer.zIndex = 5;
    }
    // Pure container-local geometry per tile. Tint and the last-tile
    // fresh-nudge / animation remain renderer-owned below.
    const discardOptions = options;
    const discardPlacements = layoutDiscards(
      this.resources.tileDesign,
      seat as Seat,
      discards,
      riichiIdx,
      discardOptions
    );
    let animLastPlacement: TilePlacement | null = null;
    for (const placement of discardPlacements) {
      const i = placement.index;
      if (lastIsAnimating && i === lastIdx) {
        animLastPlacement = placement;
        continue;
      }
      const sprite = factory.create({
        atlasId: placement.atlasId,
        tile: placement.tile,
        width: placement.sprite.width,
        height: placement.sprite.height,
        rotation: placement.sprite.rotation,
      });
      sprite.position.set(placement.sprite.x, placement.sprite.y);
      // Wait-tint + fresh-tsumogiri darken cue: the pure layout
      // carries no tint. Tsumogiri is suppressed when already
      // wait-tinted so the red cue stays legible; parallel-array
      // lookups are defensive for older snapshots.
      const tinted = tintTile(sprite, placement.tile);
      const wasTsumogiri = view.discardTsumogiri[seat]?.[i] ?? false;
      const discardOrdinal = view.discardOrdinals[seat]?.[i] ?? 0;
      if (
        !tinted &&
        shouldTintTsumogiri(
          wasTsumogiri,
          this.tsumogiriTintMode,
          view.totalDiscards - discardOrdinal
        )
      ) {
        sprite.tint = TSUMOGIRI_FRESH_TINT;
      }
      const wrap = new Container();
      wrap.addChild(sprite);
      wrap.zIndex = placement.zIndex;
      wrap.rotation = placement.wrap.rotation;
      wrap.position.set(placement.wrap.x, placement.wrap.y);
      discardContainer.addChild(wrap);
    }
    // Continuous drop shadow that always falls SCREEN-right: bucket
    // tiles into screen-vertical columns and shadow each on its
    // screen-right edge, below all tiles. Per-column for top/bottom
    // seats, per-row for left/right seats — handled automatically.
    {
      const rot = SEAT_CONTAINER_ROT[seat];
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const layer = this.shadows.screenShadowLayer(discardShadowHost, rot);
      this.shadows.placeColumnShadows(
        layer,
        discardPlacements
          // The in-flight last discard paints its own moving shadow in
          // the animated overlay below; skip its settled shadow so it
          // doesn't appear at the destination before the tile lands.
          .filter((p) => !(lastIsAnimating && p.index === lastIdx))
          .map((p) => {
            // Resolve the tile's true screen-space centre and
            // footprint. The sprite offset passes through the wrap's
            // own rotation (non-zero for the sideways riichi tile),
            // and the footprint uses the tile's total on-screen
            // rotation — so a tilted tile buckets into the same
            // screen-column as its row instead of punching a hole
            // that ruptures the continuous strip.
            const wr = p.wrap.rotation;
            const wc = Math.cos(wr);
            const ws = Math.sin(wr);
            const lx = p.wrap.x + (p.sprite.x * wc - p.sprite.y * ws);
            const ly = p.wrap.y + (p.sprite.x * ws + p.sprite.y * wc);
            const theta = rot + wr + p.sprite.rotation;
            const tc = Math.abs(Math.cos(theta));
            const ts = Math.abs(Math.sin(theta));
            const fw = p.sprite.width * tc + p.sprite.height * ts;
            const fh = p.sprite.width * ts + p.sprite.height * tc;
            return {
              ax: lx * cos - ly * sin,
              ay: lx * sin + ly * cos,
              w: fw,
              h: fh,
            };
          }),
        true
      );
    }
    // Position the discard container inside `layout.discards[seat]`.
    // The container's local axes have tile 0 at (0, 0), +x along
    // the row direction, +y across rows. After rotation, the
    // visible rect on screen matches the layout pond rect.
    const discardRect = layout.discards[seat];
    switch (seat) {
      case 0: {
        // bottom — no rotation. Local (0,0) → top-left of rect.
        discardContainer.position.set(discardRect.x, discardRect.y);
        break;
      }
      case 1: {
        // right — rotate -90°. Local +x maps to screen -y, local
        // +y maps to screen +x. Local (0,0) → bottom-left of rect.
        discardContainer.rotation = -Math.PI / 2;
        discardContainer.position.set(
          discardRect.x,
          discardRect.y + discardRect.h
        );
        break;
      }
      case 2: {
        // top — rotate 180°. Local (0,0) → bottom-right of rect.
        discardContainer.rotation = Math.PI;
        discardContainer.position.set(
          discardRect.x + discardRect.w,
          discardRect.y + discardRect.h
        );
        break;
      }
      case 3: {
        // left — rotate 90°. Local +x maps to screen +y, local
        // +y maps to screen -x. Local (0,0) → top-right of rect.
        discardContainer.rotation = Math.PI / 2;
        discardContainer.position.set(
          discardRect.x + discardRect.w,
          discardRect.y
        );
        break;
      }
    }
    frame.root.addChild(discardContainer);
    discardShadowHost.position.set(
      discardContainer.position.x,
      discardContainer.position.y
    );
    discardShadowHost.rotation = discardContainer.rotation;

    // -----------------------------------------------------------------
    // Animated last-discard overlay.
    //
    // Built after the container is parented to `frame.root` so
    // `handContainer.toGlobal(...)` / `discardContainer.toLocal(...)`
    // produce valid coordinates (both containers' world
    // transforms are now up to date).
    //
    // Phase A ("to-nudge"): interpolate from the hidden hand
    // slot's center (transformed into discard-container-local
    // coords) to the +10/+10 nudged pond position.
    //
    // Phase B ("to-final"): interpolate from the +10/+10 nudged
    // position back to the flush row position.
    // -----------------------------------------------------------------
    if (
      lastIsAnimating &&
      seatDiscardAnim &&
      animLastPlacement &&
      !discardWaitingToStart
    ) {
      const progress = this.animator.getProgress(seat);
      const finalX = animLastPlacement.wrap.x;
      const finalY = animLastPlacement.wrap.y;
      const nudgedX = finalX + 10;
      const nudgedY = finalY + 10;
      let posX: number;
      let posY: number;
      if (seatDiscardAnim.phase === "to-final") {
        posX = nudgedX + (finalX - nudgedX) * progress;
        posY = nudgedY + (finalY - nudgedY) * progress;
      } else {
        const source = seatDiscardAnim.draggedSourceCenter
          ? discardContainer.toLocal(
              handContainer.toGlobal(seatDiscardAnim.draggedSourceCenter)
            )
          : computeHandSlotInDiscardLocal(
              frame.presentation,
              handContainer,
              discardContainer,
              seat,
              seatDiscardAnim.sourceSlot?.handIndex ?? 0,
              layout,
              isFreshlyDrawn,
              hand.length,
              isSideHand,
              sideHandRevealed
            );
        posX = source.x + (nudgedX - source.x) * progress;
        posY = source.y + (nudgedY - source.y) * progress;
      }
      // Reuse the skipped last placement so the flying tile matches
      // exactly what the static loop would have drawn; only the tile
      // string comes from the animator.
      const sprite = factory.create({
        atlasId: animLastPlacement.atlasId,
        tile: seatDiscardAnim.tile,
        width: animLastPlacement.sprite.width,
        height: animLastPlacement.sprite.height,
        rotation: animLastPlacement.sprite.rotation,
      });
      sprite.position.set(
        animLastPlacement.sprite.x,
        animLastPlacement.sprite.y
      );
      // Tsumogiri fresh-tint: keep the animated tile consistent with
      // how the static last-discard would have looked.
      if (
        shouldTintTsumogiri(
          seatDiscardAnim.isTsumogiri,
          this.tsumogiriTintMode,
          0
        )
      ) {
        sprite.tint = TSUMOGIRI_FRESH_TINT;
      }
      const wrap = new Container();
      wrap.addChild(sprite);
      const shadow = this.shadows.makeTileShadow(
        {
          width: animLastPlacement.sprite.width,
          height: animLastPlacement.sprite.height,
          rotation: animLastPlacement.sprite.rotation,
          cx: animLastPlacement.sprite.x,
          cy: animLastPlacement.sprite.y,
        },
        SEAT_CONTAINER_ROT[seat] + animLastPlacement.wrap.rotation
      );
      wrap.position.set(posX, posY);
      wrap.rotation = animLastPlacement.wrap.rotation;
      // Match the z-order the static loop would have used for this
      // same (last) tile so it doesn't jump in front of its row
      // neighbour (side seats) or the previous row (top seat).
      wrap.zIndex = animLastPlacement.zIndex;
      discardContainer.addChild(wrap);
      if (shadow) {
        // The permanent host keeps this shadow on the same root layer
        // as settled shadows throughout both animation phases.
        this.shadows.placeTileShadow(
          discardShadowHost,
          shadow,
          posX,
          posY,
          animLastPlacement.wrap.rotation
        );
      }
    }

    // Riichi stick: a horizontal white rectangle with a red dot,
    // laid in front of each seat that has declared riichi. Sits
    // just inboard (table-center side) of the discard pile.
    if (view.riichiDeclared[seat]) {
      const metrics = riichiStickMetrics(
        frame.presentation,
        this.resources.tileDesign,
        options
      );
      const {
        width: stickW,
        height: stickH,
        gap: stickGap,
        dotRadius,
        cornerRadius,
      } = metrics;
      const stick = new Container();
      const bar = new Graphics()
        .roundRect(0, 0, stickW, stickH, cornerRadius)
        .fill({ color: 0xf5f5f5 });
      const dot = new Graphics()
        .circle(stickW / 2, stickH / 2, dotRadius)
        .fill({ color: 0xc04040 });
      stick.addChild(bar, dot);
      // The stick sits just inboard (table-centre side) of the
      // pond. We compute the inboard edge from the pond rect and
      // place the stick centred along the perpendicular axis.
      const centerX = layout.center.x + layout.center.w / 2;
      const centerY = layout.center.y + layout.center.h / 2;
      if (frame.presentation === "mobile") {
        const placement = mobileRiichiStickPlacement(
          discardRect,
          layout.center,
          seat as Seat,
          metrics
        );
        stick.position.set(placement.x, placement.y);
        stick.rotation = placement.rotation;
      } else {
        switch (seat) {
          case 0: {
            // bottom — horizontal, stick above the pond's top edge
            stick.position.set(centerX - stickW / 2, discardRect.y - stickGap);
            break;
          }
          case 1: {
            // right — vertical, stick to the left of the pond's left edge
            stick.rotation = -Math.PI / 2;
            stick.position.set(discardRect.x - stickGap, centerY + stickW / 2);
            break;
          }
          case 2: {
            // top — horizontal, mirrored, below the pond's bottom edge
            stick.rotation = Math.PI;
            stick.position.set(
              centerX + stickW / 2,
              discardRect.y + discardRect.h + stickGap
            );
            break;
          }
          case 3: {
            // left — vertical, to the right of the pond's right edge
            stick.rotation = Math.PI / 2;
            stick.position.set(
              discardRect.x + discardRect.w + stickGap,
              centerY - stickW / 2
            );
            break;
          }
        }
      }
      stick.zIndex = RIICHI_STICK_Z_INDEX;
      frame.root.addChild(stick);
    }
  }
}

export function computeHandSlotInDiscardLocal(
  presentation: TableRendererPresentation,
  handContainer: Container,
  discardContainer: Container,
  seat: number,
  slotIdx: number,
  layout: TableLayout,
  isFreshlyDrawn: boolean,
  handLength: number,
  isSideHand: boolean,
  sideHandRevealed: boolean
): { x: number; y: number } {
  const handGap = isFreshlyDrawn ? TSUMO_GAP : 0;
  const extraGap = handGap > 0 && slotIdx === handLength - 1 ? handGap : 0;
  let lx: number;
  let ly: number;
  if (isSideHand) {
    if (sideHandRevealed) {
      const stride = SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ;
      lx = slotIdx * stride + extraGap + SIDE_TILE_H / 2;
      ly = SIDE_TILE_W / 2;
    } else {
      const ts = layout.tileSide;
      const stride = ts.h - layout.tileSideOverlap;
      lx = slotIdx * stride + extraGap + ts.h / 2;
      ly = ts.w / 2;
    }
  } else if (seat === 0) {
    const focusedMetrics = focusedHandTileMetrics(layout, presentation);
    const t = focusedMetrics.tile;
    lx = slotIdx * (t.w + t.gap) + extraGap + focusedMetrics.spriteW / 2;
    ly = focusedMetrics.spriteH / 2;
  } else {
    // Seat 2 (top): face-down small backs sized to tileHorizontal.
    const t = layout.tileHorizontal;
    lx = slotIdx * (t.w + t.gap) + extraGap + t.w / 2;
    ly = t.h / 2;
  }
  const global = handContainer.toGlobal({ x: lx, y: ly });
  return discardContainer.toLocal(global);
}

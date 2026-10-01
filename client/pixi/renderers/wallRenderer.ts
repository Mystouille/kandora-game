import { Container, Sprite } from "pixi.js";
import type { Seat } from "../tableGeometry";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import type { MeldSheetKey as SheetKey } from "../results/resultTypes";
import { buildNormalWallPlan } from "../walls/normalWallPlan";
import { buildDuplicateWallPlan } from "../walls/duplicateWallPlan";
import type { WallRenderPlan } from "../walls/wallRenderPlan";
import { wallZIndex } from "../geometry/tableGeometry";
import { tintIfWait } from "./tileTint";
import type { TileShadows } from "./tileShadows";

export class WallRenderer {
  private showWalls = false;
  private showUndealtWall = false;
  private liveSpectate = false;

  constructor(
    private readonly resources: RenderResources,
    private readonly shadows: TileShadows,
    private readonly requestRender: () => void
  ) {}

  setShowWalls(flag: boolean): void {
    this.showWalls = flag;
  }
  setShowUndealtWall(flag: boolean): void {
    this.showUndealtWall = flag;
  }
  setLiveSpectate(flag: boolean): void {
    if (this.liveSpectate === flag) {
      return;
    }
    this.liveSpectate = flag;
    this.requestRender();
  }

  render(frame: RenderFrame): void {
    const { view, layout } = frame;

    if (!frame.root) {
      return;
    }
    if (view.duplicateWallState) {
      this.renderWallPlan(
        frame,
        buildDuplicateWallPlan({
          layout,
          metrics: {
            upright: this.resources.tileDesign.metrics.wallUpright,
            side: this.resources.tileDesign.metrics.wallSide,
            sideOverlap: this.resources.tileDesign.spacing.wallSide,
          },
          showWalls: this.showWalls,
          view,
        })
      );
      return;
    }
    // Live spectate: a relay feed carries no live/dead wall tiles, so
    // draw only the dead wall (dora + kan tiles) at a fixed position.
    if (this.liveSpectate) {
      this.renderDeadWallOnly(frame);
      return;
    }
    const plan = buildNormalWallPlan({
      layout,
      metrics: {
        upright: this.resources.tileDesign.metrics.wallUpright,
        side: this.resources.tileDesign.metrics.wallSide,
        sideOverlap: this.resources.tileDesign.spacing.wallSide,
      },
      showWalls: this.showWalls,
      showUndealtWall: this.showUndealtWall,
      view,
    });
    this.renderWallPlan(frame, plan);
  }

  private renderWallPlan(frame: RenderFrame, plan: WallRenderPlan): void {
    if (!frame.root) {
      return;
    }
    for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
      const seat = seatIndex as Seat;
      const tiles = plan.tiles.filter((tile) => tile.seat === seat);
      if (tiles.length === 0) {
        continue;
      }
      const wallContainer = new Container();
      wallContainer.label = `wall-seat-${seat}`;
      wallContainer.sortableChildren = true;
      const backSheet = this.resources.tileDesign.sheets.wallBack[
        seat
      ] as SheetKey;
      const faceSheet = this.resources.tileDesign.sheets.wallFace[
        seat
      ] as SheetKey;
      const wallShadowBoxes: Array<{
        ax: number;
        ay: number;
        w: number;
        h: number;
      }> = [];

      for (const tile of tiles) {
        const sheet = tile.faceUpTile !== null ? faceSheet : backSheet;
        const sprite = new Sprite(
          this.resources.textureStore.getTexture(sheet, tile.faceUpTile)
        );
        sprite.anchor.set(0.5, 0.5);
        sprite.width = tile.width;
        sprite.height = tile.height;
        sprite.position.set(tile.width / 2, tile.height / 2);
        if (tintIfWait(sprite, tile.faceUpTile, frame.waitTiles)) {
          // Wait tint has priority over wall-state tones.
        } else if (tile.tone === "future-draw") {
          sprite.tint = 0x88ff88;
        } else if (tile.tone === "deemphasized") {
          sprite.tint = 0xb0b0b0;
        }
        const child = new Container();
        child.addChild(sprite);
        child.position.set(tile.x, tile.y);
        child.zIndex = tile.zIndex;
        wallContainer.addChild(child);
        if (tile.castsShadow) {
          wallShadowBoxes.push({
            ax: tile.x + tile.width / 2,
            ay: tile.y + tile.height / 2,
            w: tile.width,
            h: tile.height,
          });
        }
      }
      this.shadows.placeColumnShadows(
        this.shadows.screenShadowLayer(wallContainer, 0),
        wallShadowBoxes
      );
      wallContainer.zIndex = wallZIndex(seat);
      frame.root.sortableChildren = true;
      frame.root.addChild(wallContainer);
    }
  }

  private renderDeadWallOnly(frame: RenderFrame): void {
    const { view, layout } = frame;

    if (!frame.root) {
      return;
    }
    const ROW_OFFSET_Y = 16;
    const band = layout.wall[0];
    const wallUpright = this.resources.tileDesign.metrics.wallUpright;
    const screenTileW = wallUpright.w;
    const screenTileH = wallUpright.h;
    const stride = screenTileW;
    const backSheet = this.resources.tileDesign.sheets.wallBack[0] as SheetKey;
    const faceSheet = this.resources.tileDesign.sheets.wallFace[0] as SheetKey;

    const container = new Container();
    container.sortableChildren = true;
    const wallShadowBoxes: Array<{
      ax: number;
      ay: number;
      w: number;
      h: number;
    }> = [];
    // 7 stacks × 2 rows, idxFromBreak 0..6 laid out left→right:
    //   stacks 0,1        = the 4 kan-replacement (rinshan) tiles
    //   stack 2 upper     = dora indicator, lower = ura-dora
    //   stacks 3..6 upper = kan-dora indicators (shown once revealed)
    for (let s = 0; s < 7; s++) {
      for (let row = 0; row < 2; row++) {
        let faceUpTile: string | null = null;
        if (row === 1) {
          const rank = s + 1;
          if (rank === 3) {
            faceUpTile = view.doraIndicators[0] ?? null;
          } else if (rank >= 4 && rank <= 7) {
            faceUpTile = view.doraIndicators[rank - 3] ?? null;
          }
        }
        const tex = this.resources.textureStore.getTexture(
          faceUpTile !== null ? faceSheet : backSheet,
          faceUpTile
        );
        const sprite = new Sprite(tex);
        sprite.anchor.set(0.5, 0.5);
        sprite.width = screenTileW;
        sprite.height = screenTileH;
        sprite.position.set(screenTileW / 2, screenTileH / 2);
        const child = new Container();
        child.addChild(sprite);
        const childX = band.x + s * stride;
        const childY =
          band.y + (row === 0 ? ROW_OFFSET_Y / 2 : -ROW_OFFSET_Y / 2);
        child.position.set(childX, childY);
        // Upper stack tile (row 1) peeks over its lower partner.
        child.zIndex = row;
        container.addChild(child);
        if (row === 0) {
          wallShadowBoxes.push({
            ax: childX + screenTileW / 2,
            ay: childY + screenTileH / 2,
            w: screenTileW,
            h: screenTileH,
          });
        }
      }
    }
    this.shadows.placeColumnShadows(
      this.shadows.screenShadowLayer(container, 0),
      wallShadowBoxes
    );
    // Wall layer on the sortable root (below discards=5 / hands=10).
    container.zIndex = 2;
    frame.root.addChild(container);
  }
}

import { Graphics } from "pixi.js";
import type { RenderFrame } from "../scene/renderTypes";
import type { Rect } from "../tableLayout";
import type { Seat } from "../tableGeometry";
import type { TileDesign } from "../tiles/tileDesign";
import type { WebTableLayoutMode } from "../layouts/webTableLayout";
import { webDiscardLayoutOptions } from "../layouts/webTableLayout";
import {
  MOBILE_DISCARD_PANEL_PADDING,
  mobileDiscardLayoutOptions,
} from "../layouts/mobileTableLayout";
import {
  potentialDiscardBounds,
  type DiscardLayoutOptions,
} from "../tileAreaLayout";
import { localRectToTable, seatTransform } from "../seatTransform";
import { focusedHandTileMetrics } from "../geometry/handGeometry";
import {
  playerIdentityCenter,
  type SeatRects,
} from "../geometry/tableGeometry";
import {
  HAND_PANEL_RADIUS,
  HAND_PANEL_ALPHA,
  PLAYER_PANEL_SIZE,
  PLAYER_PANEL_GAP,
  PLAYER_PANEL_LINK_WIDTH,
  PLAYER_PANEL_ALPHA,
} from "../geometry/renderConstants";

export class TablePanels {
  private readonly discardFootprintBySeat = new Map<string, Rect>();
  constructor(private readonly tileDesign: TileDesign) {}

  clear(): void {
    this.discardFootprintBySeat.clear();
  }

  render(frame: RenderFrame, panels: SeatRects): void {
    this.renderHandPanels(frame);
    this.renderDiscardPanels(frame, panels);
  }

  discardLayoutOptions(
    frame: Pick<RenderFrame, "layout" | "presentation">,
    mode: WebTableLayoutMode
  ): DiscardLayoutOptions | undefined {
    const layout = frame.layout;

    if (frame.presentation === "mobile") {
      return mobileDiscardLayoutOptions(this.tileDesign, layout);
    }
    return webDiscardLayoutOptions(mode, this.tileDesign, layout);
  }

  discardPanelRects(
    frame: RenderFrame,
    layoutId: string,
    mode: WebTableLayoutMode
  ): [Rect, Rect, Rect, Rect] {
    return [
      this.discardPanelRect(frame, layoutId, mode, 0),
      this.discardPanelRect(frame, layoutId, mode, 1),
      this.discardPanelRect(frame, layoutId, mode, 2),
      this.discardPanelRect(frame, layoutId, mode, 3),
    ];
  }

  private discardPanelRect(
    frame: RenderFrame,
    layoutId: string,
    mode: WebTableLayoutMode,
    seat: Seat
  ): Rect {
    const layout = frame.layout;

    const typedSeat = seat as Seat;
    const pond = layout.discards[typedSeat];
    const cacheKey = `${frame.presentation}:${mode}:${layoutId}:${typedSeat}`;
    let localFootprint = this.discardFootprintBySeat.get(cacheKey);
    if (!localFootprint) {
      localFootprint = potentialDiscardBounds(
        this.tileDesign,
        typedSeat,
        18,
        this.discardLayoutOptions(frame, mode)
      );
      this.discardFootprintBySeat.set(cacheKey, localFootprint);
    }
    const footprint = localRectToTable(
      seatTransform(typedSeat),
      pond,
      localFootprint
    );
    const padding =
      frame.presentation === "mobile" ? MOBILE_DISCARD_PANEL_PADDING : 4;
    return {
      x: footprint.x - padding,
      y: footprint.y - padding,
      w: footprint.w + padding * 2,
      h: footprint.h + padding * 2,
    };
  }

  private renderHandPanels(frame: RenderFrame): void {
    const layout = frame.layout;

    if (!frame.root) {
      return;
    }
    const focusedMetrics = focusedHandTileMetrics(layout, frame.presentation);
    for (let seat = 0; seat < 4; seat++) {
      const hb = layout.hands[seat];
      const panelRect =
        seat === 0
          ? {
              x: hb.x,
              y: hb.y + focusedMetrics.spriteH - layout.hands[2].h,
              w: hb.w,
              h: layout.hands[2].h,
            }
          : hb;
      const panel = new Graphics()
        .roundRect(
          panelRect.x,
          panelRect.y,
          panelRect.w,
          panelRect.h,
          HAND_PANEL_RADIUS
        )
        .fill({ color: 0x000000, alpha: HAND_PANEL_ALPHA });
      panel.zIndex = -10;
      frame.root.addChild(panel);
    }
  }

  private renderDiscardPanels(frame: RenderFrame, panels: SeatRects): void {
    if (!frame.root) {
      return;
    }
    const discardPanels = panels;
    for (let seat = 0; seat < 4; seat++) {
      const typedSeat = seat as Seat;
      const panelRect = discardPanels[typedSeat];
      const panel = new Graphics()
        .roundRect(
          panelRect.x,
          panelRect.y,
          panelRect.w,
          panelRect.h,
          HAND_PANEL_RADIUS
        )
        .fill({ color: 0x000000, alpha: HAND_PANEL_ALPHA });
      panel.zIndex = -10;
      frame.root.addChild(panel);

      const identityCenter = playerIdentityCenter(discardPanels, typedSeat);
      const playerPanelX = identityCenter.x - PLAYER_PANEL_SIZE / 2;
      const playerPanelY = identityCenter.y - PLAYER_PANEL_SIZE / 2;
      let linkX = 0;
      let linkY = 0;
      let linkW = 0;
      let linkH = 0;
      if (seat === 0) {
        linkX = panelRect.x + panelRect.w;
        linkY = identityCenter.y - PLAYER_PANEL_LINK_WIDTH / 2;
        linkW = PLAYER_PANEL_GAP;
        linkH = PLAYER_PANEL_LINK_WIDTH;
      } else if (seat === 1) {
        linkX = identityCenter.x - PLAYER_PANEL_LINK_WIDTH / 2;
        linkY = panelRect.y - PLAYER_PANEL_GAP;
        linkW = PLAYER_PANEL_LINK_WIDTH;
        linkH = PLAYER_PANEL_GAP;
      } else if (seat === 2) {
        linkX = panelRect.x - PLAYER_PANEL_GAP;
        linkY = identityCenter.y - PLAYER_PANEL_LINK_WIDTH / 2;
        linkW = PLAYER_PANEL_GAP;
        linkH = PLAYER_PANEL_LINK_WIDTH;
      } else {
        linkX = identityCenter.x - PLAYER_PANEL_LINK_WIDTH / 2;
        linkY = panelRect.y + panelRect.h;
        linkW = PLAYER_PANEL_LINK_WIDTH;
        linkH = PLAYER_PANEL_GAP;
      }
      const playerPanel = new Graphics()
        .rect(linkX, linkY, linkW, linkH)
        .fill({ color: 0x000000, alpha: PLAYER_PANEL_ALPHA })
        .roundRect(
          playerPanelX,
          playerPanelY,
          PLAYER_PANEL_SIZE,
          PLAYER_PANEL_SIZE,
          8
        )
        .fill({ color: 0x000000, alpha: PLAYER_PANEL_ALPHA });
      playerPanel.zIndex = -10;
      frame.root.addChild(playerPanel);
    }
  }
}

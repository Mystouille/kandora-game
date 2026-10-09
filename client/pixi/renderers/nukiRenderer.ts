import { Container, Graphics } from "pixi.js";
import type { Seat } from "~/game/protocol/seat";
import type { RenderFrame, RenderResources } from "../scene/renderTypes";
import { SEAT_CONTAINER_ROT } from "../geometry/renderConstants";
import {
  playerIdentityCenter,
  type SeatRects,
} from "../geometry/tableGeometry";

/** Public bonus tiles have their own strip, never the hand's meld strip. */
export function renderNukiTiles(
  frame: RenderFrame,
  resources: RenderResources,
  seat: Seat,
  discardPanels: SeatRects
): void {
  const extracted =
    frame.view.rulesFamily === "mcr"
      ? (frame.view.flowerTiles?.[seat] ?? [])
      : (frame.view.nukiTiles?.[seat] ?? []);
  const pending =
    frame.view.pendingNuki?.seat === seat &&
    frame.view.sanmaType !== "kansai" &&
    (frame.view.phase === undefined || frame.view.phase === "awaiting_chankan")
      ? frame.view.pendingNuki
      : null;
  if (extracted.length === 0 && !pending) {
    return;
  }
  const tiles = pending ? [...extracted, pending.tile] : extracted;
  const width = 25;
  const height = 38;
  const rowWidth = tiles.length * width;
  const center = playerIdentityCenter(discardPanels, seat);
  const container = new Container();
  container.label =
    frame.view.rulesFamily === "mcr"
      ? `flowers-seat-${seat}`
      : `nuki-seat-${seat}`;
  container.eventMode = "none";
  container.zIndex = 11;
  container.position.set(center.x, center.y);
  container.rotation = SEAT_CONTAINER_ROT[seat];
  // Sanma has no Buu chips: the lower part of its identity panel is public bonus space.
  container.addChild(
    new Graphics()
      .roundRect(-rowWidth / 2 - 3, 17, rowWidth + 6, height + 4, 3)
      .fill({ color: 0x000000, alpha: 0.65 })
  );
  tiles.forEach((tile, index) => {
    const sprite = resources.spriteFactory.create({
      atlasId: resources.tileDesign.sheets.discard[0],
      tile,
      width,
      height,
      anchor: 0,
    });
    sprite.position.set(-rowWidth / 2 + index * width, 19);
    if (pending && index === tiles.length - 1) {
      sprite.alpha = 0.55;
    }
    container.addChild(sprite);
  });
  frame.root.addChild(container);
}

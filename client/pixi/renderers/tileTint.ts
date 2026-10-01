import type { Sprite } from "pixi.js";

export function tintIfWait(
  sprite: Pick<Sprite, "tint">,
  tile: string | null | undefined,
  waitTiles: ReadonlySet<string>
): boolean {
  if (!tile || waitTiles.size === 0) {
    return false;
  }
  const norm = tile[0] === "0" ? `5${tile[1]}` : tile;
  if (waitTiles.has(norm)) {
    sprite.tint = 0xff5555;
    return true;
  }
  return false;
}

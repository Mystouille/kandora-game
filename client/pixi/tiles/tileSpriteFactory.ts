/**
 * Turns a resolved tile appearance into a sized, rotated, optionally
 * tinted Pixi `Sprite`. It centralises the sprite-creation pattern
 * that was repeated across every render pass (texture lookup →
 * `new Sprite` → anchor → width/height → rotation → tint).
 *
 * Callers resolve the atlas id from the active design's `sheets`
 * (Phase 5 area layout) and pass footprint/rotation as data, so this
 * module stays free of per-area/per-seat branching. One of the three
 * Pixi-importing modules (with the texture store and `TableRenderer`).
 */
import { Sprite } from "pixi.js";
import type { TileTextureStore } from "./tileTextureStore";
import type { AtlasId } from "./tileDesign";

export interface TileSpriteSpec {
  atlasId: AtlasId;
  tile: string | null;
  /** On-screen footprint (design px), already chosen by the caller. */
  width: number;
  height: number;
  /** Local rotation in radians. Default 0. */
  rotation?: number;
  /** Sprite anchor (same value on both axes). Default 0.5 (centre). */
  anchor?: number;
  /** Multiplicative tint (0xRRGGBB). Omit for the natural face. */
  tint?: number;
}

export class TileSpriteFactory {
  private readonly store: TileTextureStore;

  constructor(store: TileTextureStore) {
    this.store = store;
  }

  create(spec: TileSpriteSpec): Sprite {
    const sprite = new Sprite(this.store.getTexture(spec.atlasId, spec.tile));
    sprite.anchor.set(spec.anchor ?? 0.5);
    sprite.width = spec.width;
    sprite.height = spec.height;
    if (spec.rotation) {
      sprite.rotation = spec.rotation;
    }
    if (spec.tint !== undefined) {
      sprite.tint = spec.tint;
    }
    return sprite;
  }
}

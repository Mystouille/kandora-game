/**
 * Loads a tile design's atlases and hands out cached Pixi textures
 * per (atlas, frame). Extracted from the renderer's former
 * `mount()` sheet-loading loop and `getTileTexture()`; it owns the
 * sub-textures it creates and nothing else.
 *
 * One of only three modules allowed to import `pixi.js` (with the
 * sprite factory and `TableRenderer`); all geometry/design math it
 * relies on lives in the Pixi-free `tileDesign` helpers.
 */
import { Assets, Rectangle, Texture } from "pixi.js";
import type { Size } from "../tableGeometry";
import {
  atlasCellSize,
  frameRect,
  resolveTileFrame,
  type AtlasId,
  type TileDesign,
} from "./tileDesign";

interface LoadedAtlas {
  texture: Texture;
  cell: Size;
}

export class TileTextureStore {
  private readonly design: TileDesign;
  private readonly atlases = new Map<AtlasId, LoadedAtlas>();
  private readonly frames = new Map<string, Texture>();
  private loaded = false;

  constructor(design: TileDesign) {
    this.design = design;
  }

  get designId(): string {
    return this.design.id;
  }

  /** Load every atlas the design declares. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const entries = Object.entries(this.design.atlases);
    const results = await Promise.all(
      entries.map(async ([id, atlas]) => {
        const texture = (await Assets.load(atlas.url)) as Texture;
        return { id, atlas, texture };
      })
    );
    for (const { id, atlas, texture } of results) {
      const cell = atlasCellSize(atlas, texture.width, texture.height);
      this.atlases.set(id, { texture, cell });
    }
    this.loaded = true;
  }

  /**
   * Texture for a tile on the named atlas. Single-image atlases
   * return the whole texture; grid atlases return a cached
   * sub-texture framed to the tile's cell.
   */
  getTexture(atlasId: AtlasId, tile: string | null): Texture {
    const entry = this.atlases.get(atlasId);
    if (!entry) {
      throw new Error(`TileTextureStore: atlas ${atlasId} not loaded`);
    }
    const atlas = this.design.atlases[atlasId];
    const cell = resolveTileFrame(atlas, tile);
    if (cell === null) {
      return entry.texture;
    }
    const key = `${atlasId}:${cell.row}:${cell.col}`;
    const cached = this.frames.get(key);
    if (cached) {
      return cached;
    }
    const inset = atlas.kind === "grid" ? atlas.inset ?? 0 : 0;
    const r = frameRect(cell, entry.cell.w, entry.cell.h, inset);
    const tex = new Texture({
      source: entry.texture.source,
      frame: new Rectangle(r.x, r.y, r.w, r.h),
    });
    this.frames.set(key, tex);
    return tex;
  }

  /** Destroy the sub-textures this store created, leaving the base
   * atlas sources (owned by the Pixi asset cache) intact. */
  destroy(): void {
    for (const tex of this.frames.values()) {
      tex.destroy(false);
    }
    this.frames.clear();
    this.atlases.clear();
    this.loaded = false;
  }
}

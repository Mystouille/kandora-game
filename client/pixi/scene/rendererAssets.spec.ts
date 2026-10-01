import {
  installSceneEnvironment,
  logoLoad,
  sceneMocks,
} from "../results/pixiTestHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Texture } from "pixi.js";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import { TileTextureStore } from "../tiles/tileTextureStore";
import { RendererAssets } from "./rendererAssets";

beforeEach(() => {
  installSceneEnvironment();
  vi.spyOn(TileTextureStore.prototype, "load").mockResolvedValue();
  logoLoad.mockReset().mockResolvedValue(Texture.EMPTY);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("renderer asset owner", () => {
  it("keeps one readonly resource view and loads icons before the scene can render", async () => {
    const owner = new RendererAssets(tenhouTileDesign);
    const resources = owner.resources;
    expect(resources.chipIconTex).toBeNull();
    expect(resources.feltMaskTex).toBeNull();
    expect(await owner.load()).toBe(resources);
    expect(TileTextureStore.prototype.load).toHaveBeenCalledTimes(1);
    expect(logoLoad).toHaveBeenCalledTimes(3);
    expect(sceneMocks.fontLoad).toHaveBeenCalledWith(
      '400 16px "Yuji Syuku"',
      "東南西北"
    );
    expect(resources.chipIconTex).toBe(Texture.EMPTY);
    expect(resources.dabukenIconTex).toBe(Texture.EMPTY);
    expect(resources.feltMaskTex).toBe(Texture.EMPTY);
    owner.destroy();
    expect(Texture.EMPTY.destroyed).toBe(false);
  });

  it("preserves procedural icon and local font fallbacks while reporting failed optional delivery", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    sceneMocks.fontLoad.mockRejectedValueOnce(new Error("font offline"));
    logoLoad.mockRejectedValue(new Error("icons offline"));
    const owner = new RendererAssets(tenhouTileDesign);
    const resources = await owner.load();
    expect(resources.chipIconTex).toBeNull();
    expect(resources.dabukenIconTex).toBeNull();
    expect(resources.feltMaskTex).toBeNull();
    expect(warning).toHaveBeenCalledTimes(2);
    owner.destroy();
  });

  it("propagates atlas failures and destroys framed textures without destroying asset-cache sources", async () => {
    vi.mocked(TileTextureStore.prototype.load).mockRejectedValueOnce(
      new Error("atlas failed")
    );
    const destroy = vi.spyOn(TileTextureStore.prototype, "destroy");
    const owner = new RendererAssets(tenhouTileDesign);
    await expect(owner.load()).rejects.toThrow("atlas failed");
    expect(logoLoad).not.toHaveBeenCalled();
    owner.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(Texture.EMPTY.destroyed).toBe(false);
  });
});

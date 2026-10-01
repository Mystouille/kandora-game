import { afterEach, describe, expect, it, vi } from "vitest";
import { Container, Sprite, Text, Texture } from "pixi.js";
import { useMatchStore, type MatchView } from "../../store";
import { DiscardAnimator, type DiscardAnimation } from "../discardAnimator";
import { InteractionController } from "../interaction/interactionController";
import { tableLayoutFromConfig } from "../tableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { mobileTableLayout } from "../layouts/mobileTableLayout";
import { tenhouTileDesign } from "../tiles/designs/tenhouTileDesign";
import { TileTextureStore } from "../tiles/tileTextureStore";
import { TileSpriteFactory } from "../tiles/tileSpriteFactory";
import type {
  HandResult,
  RenderFrame,
  RenderResources,
} from "../scene/renderTypes";
import {
  BIG_TILE_W,
  DISCARD_ROW_OVERLAP_HORIZ,
  SHADOW_LAYER_Z,
  SIDE_TILE_H,
  SIDE_TILE_W,
  TSUMO_GAP,
} from "../geometry/renderConstants";
import { focusedHandTileMetrics } from "../geometry/handGeometry";
import {
  HandRenderer,
  type HandRenderOptions,
  type HandShadows,
} from "./handRenderer";
import { tintIfWait } from "./tileTint";

vi.mock("./tileTint", () => ({ tintIfWait: vi.fn(() => false) }));

function view(overrides: Partial<MatchView> = {}): MatchView {
  return {
    ...useMatchStore.getState(),
    mySeat: 0,
    conn: "open",
    hands: [
      ["3m", "1m", "2m"],
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ],
    melds: [[], [], [], []],
    lastHandResult: null,
    totalDiscards: 1,
    freshlyDrawnSeat: null,
    ...overrides,
  };
}

function harness(current = view(), mobile = false) {
  const textureStore = new TileTextureStore(tenhouTileDesign);
  const spriteFactory = new TileSpriteFactory(textureStore);
  const create = vi
    .spyOn(spriteFactory, "create")
    .mockImplementation((spec) => {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.anchor.set(spec.anchor ?? 0.5);
      sprite.width = spec.width;
      sprite.height = spec.height;
      sprite.rotation = spec.rotation ?? 0;
      if (spec.tint !== undefined) {
        sprite.tint = spec.tint;
      }
      return sprite;
    });
  const resources: RenderResources = {
    tileDesign: tenhouTileDesign,
    textureStore,
    spriteFactory,
    chipIconTex: null,
    dabukenIconTex: null,
    feltMaskTex: null,
  };
  const shadows = {
    screenShadowLayer: vi.fn((container: Container, rotation: number) => {
      const layer = new Container();
      layer.rotation = -rotation;
      layer.zIndex = SHADOW_LAYER_Z;
      container.addChild(layer);
      return layer;
    }),
    placeColumnShadows: vi.fn<HandShadows["placeColumnShadows"]>(),
    placeBasicShadow: vi.fn<HandShadows["placeBasicShadow"]>(),
    placeUprightShadow: vi.fn<HandShadows["placeUprightShadow"]>(),
  } satisfies HandShadows;
  const animator = new DiscardAnimator();
  const interaction = new InteractionController(animator, vi.fn());
  const renderer = new HandRenderer(resources, animator, interaction, shadows);
  const frame: RenderFrame = {
    view: current,
    layout: tableLayoutFromConfig(
      mobile ? mobileTableLayout : currentTableLayout
    ),
    root: new Container(),
    presentation: mobile ? "mobile" : "standard",
    waitTiles: new Set(["2m"]),
  };
  const options: HandRenderOptions = {
    showHands: false,
    historicalResult: null,
    isRiichiMode: () => false,
  };
  interaction.beginFrame(current);
  return {
    resources,
    create,
    shadows,
    animator,
    interaction,
    renderer,
    frame,
    options,
  };
}

function animation(
  overrides: Partial<DiscardAnimation> = {}
): DiscardAnimation {
  return {
    seat: 0,
    discardIndex: 0,
    tile: "2m",
    isRiichi: false,
    isRiichiDeclaration: false,
    isTsumogiri: false,
    phase: "to-nudge",
    startMs: 0,
    durationMs: 250,
    sourceSlot: { handIndex: 1, handLength: 3 },
    draggedSourceCenter: null,
    phaseASnapshot: {
      hand: ["1m", "2m", "2m"],
      hiddenSlot: 1,
      isFreshlyDrawn: true,
      isConcealed: false,
    },
    landSoundPlayed: false,
    settleStartMs: null,
    presentationSeq: 7,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("extracted hand pass", () => {
  it("records the seen natural strip and parents the hand before later render passes", () => {
    const h = harness();
    const record = vi.spyOn(h.animator, "recordHandLayout");
    const result = h.renderer.render(h.frame, 0, h.options);
    expect(record).toHaveBeenCalledWith(0, {
      sorted: ["1m", "2m", "3m"],
      isFreshlyDrawn: false,
      isConcealed: false,
    });
    expect(h.create.mock.calls.map(([spec]) => spec.tile)).toEqual([
      "1m",
      "2m",
      "3m",
    ]);
    expect(result.handContainer.parent).toBe(h.frame.root);
    expect(result.handContainer.zIndex).toBe(10);
    expect(result.displayMelds).toBe(h.frame.view.melds[0]);
    expect(result.animateMelds).toBe(true);
    expect(result.handWidth).toBe(
      3 * (h.frame.layout.tileSelf.w + h.frame.layout.tileSelf.gap) -
        h.frame.layout.tileSelf.gap
    );
    expect(tintIfWait).toHaveBeenNthCalledWith(
      2,
      expect.any(Sprite),
      "2m",
      h.frame.waitTiles
    );
  });

  it("records manual order in the single discard animator rather than a copied sorter", () => {
    const h = harness();
    h.interaction.setAutoSort(false);
    h.interaction.beginFrame(view({ totalDiscards: 0 }));
    const record = vi.spyOn(h.animator, "recordHandLayout");
    h.renderer.render(
      { ...h.frame, view: view({ totalDiscards: 0 }) },
      0,
      h.options
    );
    expect(record).toHaveBeenCalledWith(0, {
      sorted: ["3m", "1m", "2m"],
      isFreshlyDrawn: false,
      isConcealed: false,
    });
    expect(h.create.mock.calls.map(([spec]) => spec.tile)).toEqual([
      "3m",
      "1m",
      "2m",
    ]);
  });

  it("keeps source holes and frozen slot geometry through both discard phases", () => {
    for (const phase of ["to-nudge", "to-final"] as const) {
      const h = harness(view({ hands: [["1m", "2m"], [], [], []] }));
      const anim = animation({ phase });
      vi.spyOn(h.animator, "getAnim").mockReturnValue(anim);
      const easedPosition = vi.spyOn(h.interaction, "focusedTilePosition");
      const result = h.renderer.render(h.frame, 0, h.options);
      expect(result.seatDiscardAnim).toBe(anim);
      expect(result.hand).toBe(anim.phaseASnapshot?.hand);
      expect(result.isFreshlyDrawn).toBe(true);
      expect(h.create.mock.calls.map(([spec]) => spec.tile)).toEqual([
        "1m",
        "2m",
      ]);
      expect(easedPosition).not.toHaveBeenCalled();
      const sprites = result.handContainer.children.filter(
        (child): child is Sprite => child instanceof Sprite
      );
      expect(sprites[1].x).toBe(
        2 * (h.frame.layout.tileSelf.w + h.frame.layout.tileSelf.gap) +
          TSUMO_GAP
      );
    }
  });

  it("does not expose a future-scheduled discard's source hole early", () => {
    const h = harness(view({ hands: [["1m", "2m"], [], [], []] }));
    vi.spyOn(h.animator, "getAnim").mockReturnValue(animation());
    vi.spyOn(h.animator, "isDiscardWaitingToStart").mockReturnValue(true);
    const result = h.renderer.render(h.frame, 0, h.options);
    expect(result.discardWaitingToStart).toBe(true);
    expect(h.create.mock.calls.map(([spec]) => spec.tile)).toEqual([
      "1m",
      "2m",
      "2m",
    ]);
  });

  it("hides the settled draw and carries its shadow with the overlay", () => {
    const h = harness(view({ freshlyDrawnSeat: 0 }));
    vi.spyOn(h.animator, "isDrawing").mockReturnValue(true);
    vi.spyOn(h.animator, "isDrawTileHidden").mockReturnValue(true);
    vi.spyOn(h.animator, "getDrawProgress").mockReturnValue(0.25);
    const result = h.renderer.render(h.frame, 0, h.options);
    const sprites = result.handContainer.children.filter(
      (child): child is Sprite => child instanceof Sprite
    );
    expect(sprites[2].alpha).toBe(0);
    expect(sprites[3].alpha).toBe(1);
    expect(sprites[3].x - sprites[2].x).toBe(44 * 0.75);
    expect(h.shadows.placeUprightShadow).toHaveBeenCalledTimes(3);
    expect(h.create.mock.calls[3][0].tile).toBe("2m");
  });

  it("keeps held draws invisible without starting a slide or a settled shadow", () => {
    const h = harness(view({ freshlyDrawnSeat: 0 }));
    vi.spyOn(h.animator, "isDrawing").mockReturnValue(false);
    vi.spyOn(h.animator, "isDrawTileHidden").mockReturnValue(true);
    const result = h.renderer.render(h.frame, 0, h.options);
    const sprites = result.handContainer.children.filter(
      (child): child is Sprite => child instanceof Sprite
    );
    expect(sprites).toHaveLength(3);
    expect(sprites[2].alpha).toBe(0);
    expect(h.shadows.placeUprightShadow).toHaveBeenCalledTimes(2);
  });

  it("uses laid-flat side metrics for result masks, but preserves concealed-hand widths", () => {
    const hidden = harness();
    const ordinary = hidden.renderer.render(hidden.frame, 1, hidden.options);
    expect(ordinary.handWidth).toBe(
      2 *
        (hidden.frame.layout.tileSide.h - hidden.frame.layout.tileSideOverlap) +
        hidden.frame.layout.tileSide.h
    );
    expect(ordinary.handContainer.x).toBe(
      ordinary.handRect.x + ordinary.handRect.w - hidden.frame.layout.tileSide.w
    );
    const masked = harness(
      view({
        lastHandResult: {
          reason: "ron",
          wins: [{ seat: 0, hand: ["1m", "2m"] }],
        },
      })
    );
    const flat = masked.renderer.render(masked.frame, 1, masked.options);
    expect(flat.sideHandRevealed).toBe(false);
    expect(flat.handWidth).toBe(
      2 * (SIDE_TILE_H - DISCARD_ROW_OVERLAP_HORIZ) + SIDE_TILE_H
    );
    expect(flat.handContainer.x).toBe(
      flat.handRect.x + flat.handRect.w - SIDE_TILE_W
    );
    expect(masked.create.mock.calls.every(([spec]) => spec.tile === null)).toBe(
      true
    );
  });

  it("keeps historical side reveals independent of live source and meld animation", () => {
    const h = harness();
    const historical: HandResult = {
      reason: "ron",
      wins: [
        {
          seat: 1,
          hand: ["3s", "1s"],
          melds: [
            {
              type: "pon",
              tiles: ["5m", "5m", "5m"],
              claimedTile: "5m",
              from: 2,
            },
          ],
        },
      ],
    };
    const record = vi.spyOn(h.animator, "recordHandLayout");
    const result = h.renderer.render(h.frame, 1, {
      ...h.options,
      historicalResult: historical,
    });
    expect(record).toHaveBeenCalledWith(1, {
      sorted: [null, null, null],
      isFreshlyDrawn: false,
      isConcealed: true,
    });
    expect(result.hand).toEqual(["1s", "3s"]);
    expect(result.sideHandRevealed).toBe(true);
    expect(result.animateMelds).toBe(false);
    expect(result.displayMelds).toBe(historical.wins?.[0].melds);
  });

  it("preserves top upright shadows and switches result-masked tiles to flat shadows", () => {
    const h = harness();
    h.renderer.render(h.frame, 2, h.options);
    expect(h.shadows.placeUprightShadow).toHaveBeenCalledTimes(3);
    expect(h.shadows.placeBasicShadow).not.toHaveBeenCalled();
    const masked = harness(
      view({
        lastHandResult: { reason: "exhaustive_draw" },
      })
    );
    const result = masked.renderer.render(masked.frame, 2, masked.options);
    expect(result.handContainer.rotation).toBe(Math.PI);
    expect(masked.shadows.placeBasicShadow).toHaveBeenCalledTimes(3);
    expect(masked.shadows.placeUprightShadow).not.toHaveBeenCalled();
  });

  it("keeps mobile origin stable, replay hands inert, and furiten confined to seat zero", () => {
    const h = harness(
      view({ conn: "replay", furiten: [true, true, true, true] }),
      true
    );
    const result = h.renderer.render(h.frame, 0, h.options);
    const metrics = focusedHandTileMetrics(h.frame.layout, "mobile");
    expect(result.handContainer.x).toBe(
      result.handRect.x + result.longAxisOffset
    );
    expect(h.create.mock.calls[0][0].width).toBe(metrics.spriteW);
    expect(h.create.mock.calls[0][0].width).not.toBe(BIG_TILE_W);
    const sprites = result.handContainer.children.filter(
      (child): child is Sprite => child instanceof Sprite
    );
    expect(sprites.every((sprite) => sprite.eventMode !== "static")).toBe(true);
    const label = result.handContainer.children.find(
      (child): child is Text => child instanceof Text
    );
    expect(label?.text).toBe("Furiten");
    expect(label?.anchor.x).toBe(1);
    expect(label?.x).toBe(metrics.spriteW - 2);
    const top = h.renderer.render(h.frame, 2, h.options);
    expect(
      top.handContainer.children.some((child) => child instanceof Text)
    ).toBe(false);
  });
});

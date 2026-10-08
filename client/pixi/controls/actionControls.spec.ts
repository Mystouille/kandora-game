import {
  allText,
  createFrame,
  createResources,
} from "../results/pixiTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Container,
  EventBoundary,
  FederatedPointerEvent,
  Sprite,
  Texture,
} from "pixi.js";
import type { LegalAction } from "~/game/protocol/messages";
import { DiscardAnimator } from "../discardAnimator";
import { mobileTableLayout } from "../layouts/mobileTableLayout";
import { tableLayoutFromConfig } from "../tableLayout";
import { ActionControls } from "./actionControls";

const PASS: LegalAction = { id: "pass", type: "pass" };
const RON: LegalAction = { id: "ron", type: "ron" };
const RIICHI: LegalAction = { id: "riichi:2m", type: "riichi", tile: "2m" };
const CHI: LegalAction[] = [
  { id: "chi:4m:0m,6m", type: "chi", tile: "4m", tiles: ["6m", "0m"] },
  { id: "chi:4m:2m,3m", type: "chi", tile: "4m", tiles: ["3m", "2m"] },
];

function harness(actions: LegalAction[], mobile = false) {
  const initial = createFrame(
    { conn: "open", mySeat: 0, legalActions: actions },
    mobile ? "mobile" : "standard"
  );
  const frame = mobile
    ? { ...initial, layout: tableLayoutFromConfig(mobileTableLayout) }
    : initial;
  const resources = createResources();
  const textures = vi
    .spyOn(resources.textureStore, "getTexture")
    .mockReturnValue(Texture.EMPTY);
  const animator = new DiscardAnimator();
  const request = vi.fn();
  const actionClick = vi.fn();
  const controls = new ActionControls(animator, request, actionClick);
  const felt = { x: 0, y: 0, w: frame.layout.table.w, h: frame.layout.table.h };
  const render = (): void => {
    for (const child of frame.root.removeChildren()) {
      child.destroy({ children: true, texture: false });
    }
    controls.beginFrame(frame.view);
    controls.render(frame, resources, felt);
  };
  return {
    frame,
    resources,
    textures,
    animator,
    request,
    actionClick,
    controls,
    render,
    felt,
  };
}

function button(root: Container, label: string): Container {
  const text = allText(root).find((entry) => entry.text === label);
  if (!text?.parent) {
    throw new Error(`Missing action button ${label}`);
  }
  return text.parent;
}

function click(node: Container, mouseButton = 0): void {
  const event = new FederatedPointerEvent(new EventBoundary(node));
  event.button = mouseButton;
  node.emit("pointerdown", event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("action control owner", () => {
  it.each([false, true])(
    "keeps native sanma North voluntary, dispatches its server id and never renders Chii (mobile=%s)",
    (mobile) => {
      const nuki: LegalAction = {
        id: "native-north-id",
        type: "nuki",
        tile: "4z",
      };
      const h = harness([nuki, ...CHI], mobile);
      h.frame.view.playerCount = 3;
      h.controls.setNoCallEnabled(true);
      h.render();
      expect(
        allText(h.frame.root).some((text) => text.text.startsWith("Chi"))
      ).toBe(false);
      click(button(h.frame.root, "Nuki 北"));
      expect(h.actionClick).toHaveBeenCalledWith(
        expect.objectContaining({ action: nuki })
      );
    }
  );
  it("never offers a voluntary action for automatic Kansai fives", () => {
    const h = harness([{ id: "automatic", type: "nuki", tile: "0m" }]);
    h.frame.view.playerCount = 3;
    h.frame.view.sanmaType = "kansai";
    h.render();
    expect(h.controls.bounds).toHaveLength(0);
  });
  it("keeps tile-driven actions out of controls and owns riichi selection without changing legality", () => {
    const h = harness([
      { id: "discard:2m", type: "discard", tile: "2m" },
      { id: "draw", type: "draw" },
      RIICHI,
    ]);
    h.render();
    expect(h.controls.bounds).toHaveLength(1);
    expect(h.frame.view.legalActions).toHaveLength(3);
    click(button(h.frame.root, "Riichi"), 2);
    expect(h.controls.isRiichiMode).toBe(false);
    click(button(h.frame.root, "Riichi"));
    expect(h.controls.isRiichiMode).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.render();
    click(button(h.frame.root, "Cancel"));
    expect(h.controls.isRiichiMode).toBe(false);
    h.controls.beginFrame({ legalActions: [] });
    expect(h.actionClick).not.toHaveBeenCalled();
  });

  it("clears stale riichi selection and call groups only from a new frame's offered actions", () => {
    const h = harness([RIICHI, ...CHI, PASS]);
    h.render();
    click(button(h.frame.root, "Riichi"));
    click(button(h.frame.root, "Chi ▾"));
    h.controls.beginFrame({ legalActions: [] });
    expect(h.controls.isRiichiMode).toBe(false);
    const closed = {
      ...h.frame,
      root: new Container(),
      view: { ...h.frame.view, legalActions: [] },
    };
    h.controls.render(closed, h.resources, h.felt);
    expect(h.controls.bounds).toHaveLength(0);
    h.render();
    expect(allText(h.frame.root).some((text) => text.text === "Chi ▾")).toBe(
      true
    );
  });

  it("defers call choices while the single discard animator still presents the source discard", () => {
    const h = harness([...CHI, PASS]);
    const pending = vi
      .spyOn(h.animator, "isDiscardPresentationPending")
      .mockReturnValue(true);
    h.render();
    expect(h.controls.bounds).toHaveLength(0);
    pending.mockReturnValue(false);
    h.render();
    expect(h.controls.bounds).toHaveLength(2);
    click(button(h.frame.root, "Chi ▾"));
    pending.mockReturnValue(true);
    h.render();
    pending.mockReturnValue(false);
    h.render();
    expect(allText(h.frame.root).some((text) => text.text === "Chi ▾")).toBe(
      true
    );
  });

  it("suppresses host automatic calls and wins without creating another legality owner", () => {
    const h = harness([...CHI, PASS, RON, { id: "tsumo", type: "tsumo" }]);
    h.controls.setNoCallEnabled(true);
    h.controls.setNoCallEnabled(true);
    h.render();
    expect(allText(h.frame.root).map((text) => text.text)).toEqual([
      "Pass",
      "Ron",
      "Tsumo",
    ]);
    h.controls.setAutoWinEnabled(true);
    h.controls.setAutoWinEnabled(true);
    h.render();
    expect(allText(h.frame.root).map((text) => text.text)).toEqual(["Pass"]);
    h.controls.render(
      {
        ...h.frame,
        root: new Container(),
        view: { ...h.frame.view, legalActions: [...CHI, PASS] },
      },
      h.resources,
      h.felt
    );
    expect(h.controls.bounds).toHaveLength(0);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.frame.view.legalActions).toHaveLength(5);
  });

  it("expands sorted physical tile previews, ignores right-clicks and dispatches the painted option", () => {
    const h = harness([...CHI, PASS]);
    h.render();
    click(button(h.frame.root, "Chi ▾"));
    h.render();
    expect(h.textures.mock.calls.map(([, tile]) => tile)).toEqual([
      "4m",
      "0m",
      "6m",
      "2m",
      "3m",
      "4m",
    ]);
    const strip = h.frame.root.children[0];
    const choices = strip.children.filter((child) =>
      child.children.some((node) => node instanceof Sprite)
    );
    expect(choices).toHaveLength(2);
    expect(h.controls.bounds).toHaveLength(4);
    click(choices[0], 2);
    expect(h.actionClick).not.toHaveBeenCalled();
    click(choices[0]);
    expect(h.actionClick).toHaveBeenCalledWith({ action: CHI[0] });
    h.render();
    expect(h.controls.bounds).toHaveLength(2);
  });

  it("places Tenpai right of Noten and retains the original action object in the click closure", () => {
    const tenpai: LegalAction = { id: "tenpai:shown", type: "declare_tenpai" };
    const noten: LegalAction = { id: "noten:shown", type: "declare_noten" };
    const h = harness([tenpai, noten]);
    h.render();
    const ready = button(h.frame.root, "Tenpai");
    expect(ready.x).toBeGreaterThan(button(h.frame.root, "Noten").x);
    h.controls.beginFrame({ legalActions: [{ ...tenpai, id: "tenpai:new" }] });
    click(ready);
    expect(h.actionClick).toHaveBeenCalledWith({ action: tenpai });
  });

  it("honors canvas-space mobile menu boundaries and excludes every expanded row from shortcuts", () => {
    const h = harness([...CHI, PASS, RON], true);
    h.frame.root.scale.set(2);
    h.frame.root.position.set(12, 0);
    h.controls.setMobileActionButtonRightBoundary(900);
    h.controls.setMobileActionButtonRightBoundary(900);
    h.render();
    expect(h.request).toHaveBeenCalledTimes(1);
    click(button(h.frame.root, "Chi ▾"));
    h.render();
    expect(h.controls.bounds).toHaveLength(5);
    for (const rect of h.controls.bounds) {
      expect(rect.x + rect.w).toBeLessThanOrEqual((900 - 12) / 2 - 10);
      expect(rect.y + rect.h).toBeLessThanOrEqual(h.frame.layout.hands[0].y);
    }
  });

  it("clears action hit bounds after a hand result or match end", () => {
    const h = harness([RON]);
    h.render();
    expect(h.controls.bounds).toHaveLength(1);
    h.controls.render(
      {
        ...h.frame,
        view: {
          ...h.frame.view,
          lastHandResult: { reason: "exhaustive_draw", delta: [0, 0, 0, 0] },
        },
      },
      h.resources,
      h.felt
    );
    expect(h.controls.bounds).toHaveLength(0);
  });
});

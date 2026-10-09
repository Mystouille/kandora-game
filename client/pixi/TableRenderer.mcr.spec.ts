import {
  installSceneEnvironment,
  logoLoad,
  sceneMocks,
} from "./results/pixiTestHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Container,
  EventBoundary,
  FederatedPointerEvent,
  Point,
  Sprite,
  Texture,
  TextureSource,
} from "pixi.js";
import { parseTileList } from "../debugSeed";
import { findTileAction } from "../discardActions";
import { dispatchServerMessage } from "../dispatchServerMessage";
import { useMatchStore, type MatchView } from "../store";
import { bindLiveClock, releaseLiveClock } from "../time/liveClock";
import { ServerMessageSchema, type LegalAction } from "../../protocol/messages";
import { getPreset, presetToRuleSet } from "../../rules/presets";
import { MatchProcess, setReadyCheckMs } from "../../server/src/match";
import { ephemeralMatchRepository } from "../../server/src/repository";
import type { MatchRuntime } from "../../server/src/runtime";
import { gameTiming } from "../../server/src/session/timingPolicy";
import { sortHand } from "./geometry/tileOrder";
import { mobileTableLayout } from "./layouts/mobileTableLayout";
import { TableRenderer } from "./TableRenderer";

const startingHand = parseTileList("123789m123p1239s").tiles;
const originalReadyMs = gameTiming.READY_CHECK_MS;

beforeEach(() => {
  useMatchStore.getState().reset();
  installSceneEnvironment();
  logoLoad.mockResolvedValue(
    new Texture({ source: new TextureSource({ width: 4096, height: 4096 }) })
  );
  setReadyCheckMs(0);
});

afterEach(() => {
  useMatchStore.getState().reset();
  setReadyCheckMs(originalReadyMs);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function handSprites(): Sprite[] {
  const root = sceneMocks.stages.at(-1)?.children[0];
  const hand = root?.children.find((node) => node.label === "hand-seat-0");
  if (!(hand instanceof Container)) {
    throw new Error("Expected the rendered player's hand");
  }
  return hand.children.filter((node): node is Sprite => node instanceof Sprite);
}

function clickTile(sprite: Sprite): void {
  const point = sprite.toGlobal(new Point(sprite.width / 2, sprite.height / 2));
  const down = new FederatedPointerEvent(new EventBoundary(sprite));
  down.button = 0;
  down.global.copyFrom(point);
  sprite.emit("pointerdown", down);
  window.dispatchEvent(
    Object.assign(new Event("pointerup"), {
      button: 0,
      pointerType: "mouse",
      clientX: point.x,
      clientY: point.y,
    })
  );
}

async function startSeededSolo(firstDraw: string, clockOwner: object) {
  let now = 1_000;
  bindLiveClock(clockOwner, {
    now: () => now,
    quality: () => ({
      clockEpoch: "opening-draw",
      roundTripMs: 0,
      uncertaintyMs: 0,
      sampledAt: now,
    }),
  });
  const runtime: MatchRuntime = {
    clockEpoch: "opening-draw",
    now: () => now,
    random: () => 0.5,
    captureRandomState: () => 0,
    restoreRandomState: () => undefined,
    schedule: () => ({ cancel: () => undefined }),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const room = MatchProcess.createWaitingRoom(
    "mcr-opening-draw",
    42,
    { repository: ephemeralMatchRepository, runtime },
    { humanHand: startingHand, humanDraws: [firstDraw] },
    presetToRuleSet(getPreset("mcr-ema")),
    "mcr-ema"
  );
  const seat = room.claimSeat("tester", "Tester");
  if (seat !== 0) {
    throw new Error("Expected the debug player in seat 0");
  }
  useMatchStore.getState().setMatch(room.matchId, seat);
  useMatchStore.getState().setConn("open");
  room.attachHuman(seat, (message) => {
    dispatchServerMessage(ServerMessageSchema.parse(message), {
      onError: (code, text) => {
        throw new Error(`${code}: ${text}`);
      },
      onSequenceGap: (gap) => {
        throw new Error(`Unexpected event gap at ${gap.expectedSeq}`);
      },
    });
  });
  room.setWaitingRoomReady(seat, true);
  await room.startWaitingRoom(seat);
  return {
    room,
    advanceToDecision: () => {
      const decision = room.owners.actionWindows.timedView(0);
      if (decision === null) {
        throw new Error("Expected an active player decision");
      }
      now = Math.max(now, decision.opensAt);
    },
  };
}

describe("MCR opening draw interaction", () => {
  for (const layout of ["standard", "compact", "mobile"] as const) {
    it.each([
      { gesture: "left", firstDraw: "5p" },
      { gesture: "right", firstDraw: "5p" },
      { gesture: "left", firstDraw: "9s" },
      { gesture: "right", firstDraw: "9s" },
    ])(
      `${layout}: $gesture-click discards opening $firstDraw without a ghost tile`,
      async ({ gesture, firstDraw }) => {
        const renderer = new TableRenderer(
          layout === "mobile"
            ? { presentation: "mobile", layoutConfig: mobileTableLayout }
            : { webTableLayoutMode: layout }
        );
        renderer.setAnimationsEnabled(false);
        renderer.setAutoSort(true);
        const selected: LegalAction[] = [];
        renderer.setOnTileClick(({ tile, discardSource, index }) => {
          const state = useMatchStore.getState();
          const action = findTileAction(
            state.legalActions,
            "discard",
            tile,
            discardSource
          );
          if (action === undefined) {
            throw new Error(`No legal ${discardSource} discard for ${tile}`);
          }
          selected.push(action);
          state.setPendingDiscard({ seat: 0, tile, displayIndex: index });
        });
        renderer.setOnActionClick(({ action }) => {
          selected.push(action);
          useMatchStore.getState().setLegalActions([]);
        });
        const discardedViews: MatchView[] = [];
        const unsubscribe = useMatchStore.subscribe((state, previous) => {
          if (state.discards[0].length > previous.discards[0].length) {
            discardedViews.push(state);
          }
        });
        try {
          await renderer.mount(new HTMLElement());
          const { room, advanceToDecision } = await startSeededSolo(
            firstDraw,
            renderer
          );
          advanceToDecision();
          const opening = useMatchStore.getState();
          expect(opening.hands[0]).toEqual([...startingHand, firstDraw]);
          expect(opening.freshlyDrawnSeat).toBe(
            room.buildSnapshotForSeat(0).state.freshlyDrawnSeat
          );
          renderer.render(opening);
          const tiles = handSprites();
          expect(tiles).toHaveLength(14);
          expect(tiles[13].x - tiles[12].x).toBeGreaterThan(
            tiles[1].x - tiles[0].x
          );

          if (gesture === "left") {
            clickTile(tiles[13]);
          } else {
            sceneMocks.canvases[0].dispatchEvent(
              Object.assign(new Event("mousedown", { cancelable: true }), {
                button: 2,
              })
            );
          }
          expect(selected).toHaveLength(1);
          expect(selected[0]).toMatchObject({
            type: "discard",
            tile: firstDraw,
            discardSource: "draw",
          });
          await room.handleAct(0, selected[0].id);
          expect(discardedViews).toHaveLength(1);
          expect(discardedViews[0].hands[0]).toEqual(startingHand);
          expect(discardedViews[0].pendingDiscard).toBeNull();
          renderer.render(discardedViews[0]);
          expect(handSprites()).toHaveLength(13);

          if (firstDraw === "9s") {
            for (let attempt = 0; attempt < 4; attempt++) {
              const current = useMatchStore.getState();
              if (current.turn === 0 && current.phase === "awaiting_discard") {
                break;
              }
              const pass = current.legalActions.find(
                (action) => action.type === "pass"
              );
              if (pass === undefined) {
                throw new Error("Expected a call window before the next draw");
              }
              await room.handleAct(0, pass.id);
            }
            const nextTurn = useMatchStore.getState();
            expect(nextTurn.freshlyDrawnSeat).toBe(0);
            expect(nextTurn.hands[0]).toHaveLength(14);
            advanceToDecision();
            renderer.render(nextTurn);
            const display = sortHand(nextTurn.hands[0], true);
            const handCopy = display.slice(0, -1).indexOf("9s");
            expect(handCopy).toBeGreaterThanOrEqual(0);
            clickTile(handSprites()[handCopy]);
            expect(selected[1]).toMatchObject({
              type: "discard",
              tile: "9s",
              discardSource: "hand",
            });
            await room.handleAct(0, selected[1].id);
            expect(discardedViews[1].hands[0]).toEqual([
              ...startingHand.slice(0, -1),
              nextTurn.hands[0].at(-1),
            ]);
            renderer.render(discardedViews[1]);
            expect(handSprites()).toHaveLength(13);
          }
        } finally {
          unsubscribe();
          releaseLiveClock(renderer);
          renderer.destroy();
        }
      }
    );
  }
});

import { describe, expect, it } from "vitest";
import { HandSorter } from "./handSorter";

function beginDrag(sorter: HandSorter): void {
  sorter.pointerDown({
    rawIdx: 1,
    pointerLocalX: 150,
    pointerLocalY: 300,
    tileLeftX: 125,
    tileTopY: 0,
    tileLongAxisLen: 50,
    tileHeight: 100,
  });
}

describe("HandSorter two-dimensional drag", () => {
  it("follows the pointer on both axes after promotion", () => {
    const sorter = new HandSorter();
    beginDrag(sorter);

    sorter.pointerMove(190, 230, [0, 1, 2]);

    expect(sorter.getRenderX(1, 100)).toBe(165);
    expect(sorter.getRenderY(1, 0)).toBe(-70);
    expect(sorter.getDraggedTileCenter()).toEqual({ x: 190, y: -20 });
  });

  it("keeps a vertical-only drag out of the reorder path", () => {
    const sorter = new HandSorter();
    beginDrag(sorter);

    sorter.pointerMove(150, 220, [0, 1, 2]);

    expect(sorter.isDragging()).toBe(true);
    expect(sorter.isSortFlagOn()).toBe(true);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(false);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [0, 1, 2], freshGap: false }
    );
  });

  it("does not disturb an existing custom order with y movement", () => {
    const sorter = new HandSorter();
    sorter.setSortFlag(false, [2, 0, 1]);
    beginDrag(sorter);

    sorter.pointerMove(150, 220, [0, 1, 2]);

    expect(sorter.maybeSwap([50, 150, 250])).toBe(false);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [2, 0, 1], freshGap: false }
    );
  });

  it("retains horizontal neighbour swapping", () => {
    const sorter = new HandSorter();
    const sortChanges: boolean[] = [];
    sorter.setOnSortFlagChange((on) => sortChanges.push(on));
    beginDrag(sorter);

    sorter.pointerMove(260, 300, [0, 1, 2]);

    expect(sorter.isSortFlagOn()).toBe(true);
    expect(sortChanges).toEqual([]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(true);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [0, 2, 1], freshGap: false }
    );
    expect(sorter.pointerUp()).toEqual({ kind: "drop", rawIdx: 1 });
    expect(sorter.isSortFlagOn()).toBe(false);
    expect(sortChanges).toEqual([false]);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [0, 2, 1], freshGap: false }
    );
  });

  it("keeps sort on when the tile returns to its original hand slot", () => {
    const sorter = new HandSorter();
    beginDrag(sorter);

    sorter.pointerMove(260, 300, [0, 1, 2]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(true);
    sorter.pointerMove(140, 300, [0, 1, 2]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(true);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [0, 1, 2], freshGap: false }
    );

    expect(sorter.pointerUp()).toEqual({ kind: "drop", rawIdx: 1 });
    expect(sorter.isSortFlagOn()).toBe(true);
  });

  it("restores original order but keeps pointer X in the discard zone", () => {
    const sorter = new HandSorter();
    const sortChanges: boolean[] = [];
    sorter.setOnSortFlagChange((on) => sortChanges.push(on));
    beginDrag(sorter);

    sorter.pointerMove(260, 300, [0, 1, 2]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(true);
    sorter.pointerMove(260, 99, [0, 1, 2]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(true);
    expect(sorter.getRenderX(1, 100)).toBe(235);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [0, 1, 2], freshGap: false }
    );

    expect(sorter.pointerUp()).toEqual({
      kind: "discard",
      rawIdx: 1,
      draggedTileCenter: { x: 260, y: -151 },
    });
    expect(sorter.getDraggedTileCenter()).toBeNull();
    expect(sorter.isSortFlagOn()).toBe(true);
    expect(sortChanges).toEqual([]);
  });

  it("preserves an existing custom order when discarding by drag", () => {
    const sorter = new HandSorter();
    sorter.setSortFlag(false, [2, 0, 1]);
    beginDrag(sorter);

    sorter.pointerMove(260, 99, [2, 0, 1]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(false);
    expect(sorter.pointerUp()).toEqual({
      kind: "discard",
      rawIdx: 1,
      draggedTileCenter: { x: 260, y: -151 },
    });
    expect(sorter.isSortFlagOn()).toBe(false);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [2, 0, 1], freshGap: false }
    );
  });

  it("keeps a released drag-discard hidden until the hand mutates", () => {
    const sorter = new HandSorter();
    sorter.reconcile(["1m", "2m", "3m"]);
    beginDrag(sorter);
    sorter.pointerMove(230, 99, [0, 1, 2]);

    expect(sorter.pointerUp()).toEqual({
      kind: "discard",
      rawIdx: 1,
      draggedTileCenter: { x: 230, y: -151 },
    });
    expect(sorter.isReleasedDragDiscard(1)).toBe(true);
    sorter.reconcile(["1m", "2m", "3m"]);
    expect(sorter.isReleasedDragDiscard(1)).toBe(true);

    sorter.reconcile(["1m", "3m"]);
    expect(sorter.isReleasedDragDiscard(1)).toBe(false);
  });

  it("appends a newly drawn tile to an active drag preview", () => {
    const sorter = new HandSorter();
    sorter.reconcile(["1m", "2m", "3m"]);
    beginDrag(sorter);
    sorter.pointerMove(260, 300, [0, 1, 2]);
    expect(sorter.maybeSwap([50, 150, 250])).toBe(true);
    expect(sorter.getDisplayOrder(["1m", "2m", "3m"], false, [0, 1, 2])).toEqual(
      { rawIndices: [0, 2, 1], freshGap: false }
    );

    sorter.reconcile(["1m", "2m", "3m", "9m"]);
    expect(
      sorter.getDisplayOrder(
        ["1m", "2m", "3m", "9m"],
        true,
        [0, 1, 2, 3]
      )
    ).toEqual({ rawIndices: [0, 2, 1, 3], freshGap: true });
    expect(sorter.getRenderX(3, 350)).toBe(350);
    expect(sorter.isDragging()).toBe(true);
  });

  it("discards only beyond two tile heights toward the top", () => {
    const exactThreshold = new HandSorter();
    beginDrag(exactThreshold);
    exactThreshold.pointerMove(150, 100, [0, 1, 2]);
    expect(exactThreshold.isDraggedPastDiscardThreshold(1)).toBe(false);
    expect(exactThreshold.pointerUp()).toEqual({ kind: "drop", rawIdx: 1 });

    const beyondThreshold = new HandSorter();
    beginDrag(beyondThreshold);
    beyondThreshold.pointerMove(150, 99, [0, 1, 2]);
    expect(beyondThreshold.isDraggedPastDiscardThreshold(1)).toBe(true);
    expect(beyondThreshold.isDraggedPastDiscardThreshold(0)).toBe(false);
    expect(beyondThreshold.pointerUp()).toEqual({
      kind: "discard",
      rawIdx: 1,
      draggedTileCenter: { x: 150, y: -151 },
    });
    expect(beyondThreshold.isDraggedPastDiscardThreshold(1)).toBe(false);

    const downward = new HandSorter();
    beginDrag(downward);
    downward.pointerMove(150, 550, [0, 1, 2]);
    expect(downward.isDraggedPastDiscardThreshold(1)).toBe(false);
    expect(downward.pointerUp()).toEqual({ kind: "drop", rawIdx: 1 });
  });
});
import type { MatchView } from "../store";
import type { Meld } from "~/game/protocol/messages";

export const MELD_SLIDE_DURATION_MS = 350;
export const MELD_SLIDE_TILE_WIDTHS = 3;

interface MeldAnimatorOptions {
  now?: () => number;
}

interface MeldAnimation {
  seat: number;
  meldIndex: number;
  startMs: number;
  kind: "meld" | "shouminkan";
}

function animationKey(seat: number, meldIndex: number): string {
  return `${seat}:${meldIndex}`;
}

function copyMeld(meld: Meld): Meld {
  return { ...meld, tiles: [...meld.tiles] };
}

function sameMeld(left: Meld, right: Meld): boolean {
  return (
    left.type === right.type &&
    left.claimedTile === right.claimedTile &&
    left.from === right.from &&
    left.tiles.length === right.tiles.length &&
    left.tiles.every((tile, index) => tile === right.tiles[index])
  );
}

function isShouminkanUpgrade(previous: Meld, current: Meld): boolean {
  if (!(
    previous.type === "pon" &&
    current.type === "shouminkan" &&
    previous.claimedTile === current.claimedTile &&
    previous.from === current.from &&
    current.tiles.length === previous.tiles.length + 1
  )) {
    return false;
  }
  const remaining = [...current.tiles];
  for (const tile of previous.tiles) {
    const index = remaining.indexOf(tile);
    if (index < 0) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return remaining.length === 1;
}

function snapshotMelds(view: MatchView): Meld[][] {
  return [0, 1, 2, 3].map((seat) => (view.melds[seat] ?? []).map(copyMeld));
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

export function rotateMeldLocalPoint(
  localX: number,
  localY: number,
  rotation: number
): { x: number; y: number } {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: localX * cos - localY * sin,
    y: localX * sin + localY * cos,
  };
}

/**
 * Detects newly declared melds between rendered match views and exposes
 * player-local offsets for the renderer. Appended melds travel along negative
 * X (player-left); a pon-to-shouminkan upgrade travels along negative Y
 * (player-above) and is applied only to the added stack tile.
 */
export class MeldAnimator {
  private readonly now: () => number;
  private previousMelds: Meld[][] | null = null;
  private readonly animations = new Map<string, MeldAnimation>();
  private enabled = true;
  private snapNextFlag = false;

  constructor(options: MeldAnimatorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.animations.clear();
    }
  }

  snapNext(): void {
    this.snapNextFlag = true;
    this.animations.clear();
  }

  reset(): void {
    this.previousMelds = null;
    this.animations.clear();
    this.snapNextFlag = false;
  }

  beginFrame(view: MatchView): void {
    const currentMelds = snapshotMelds(view);
    const previousMelds = this.previousMelds;
    const now = this.now();
    this.previousMelds = currentMelds;
    this.dropCompleted(now);

    if (this.snapNextFlag) {
      this.snapNextFlag = false;
      this.animations.clear();
      return;
    }
    if (!previousMelds || !this.enabled) {
      return;
    }

    const candidates: Array<{
      seat: number;
      meldIndex: number;
      kind: MeldAnimation["kind"];
    }> = [];
    let ambiguousChange = false;

    for (let seat = 0; seat < 4; seat++) {
      const previous = previousMelds[seat] ?? [];
      const current = currentMelds[seat] ?? [];
      if (
        previous.length === current.length &&
        previous.every((meld, index) => sameMeld(meld, current[index]))
      ) {
        continue;
      }

      if (
        current.length === previous.length + 1 &&
        previous.every((meld, index) => sameMeld(meld, current[index]))
      ) {
        candidates.push({
          seat,
          meldIndex: current.length - 1,
          kind: "meld",
        });
        continue;
      }

      if (current.length === previous.length) {
        const changedIndices: number[] = [];
        for (let index = 0; index < current.length; index++) {
          if (!sameMeld(previous[index], current[index])) {
            changedIndices.push(index);
          }
        }
        if (
          changedIndices.length === 1 &&
          isShouminkanUpgrade(
            previous[changedIndices[0]],
            current[changedIndices[0]]
          )
        ) {
          candidates.push({
            seat,
            meldIndex: changedIndices[0],
            kind: "shouminkan",
          });
          continue;
        }
      }

      ambiguousChange = true;
      break;
    }

    if (ambiguousChange || candidates.length !== 1) {
      if (ambiguousChange || candidates.length > 1) {
        this.animations.clear();
      }
      return;
    }

    const candidate = candidates[0];
    this.animations.set(animationKey(candidate.seat, candidate.meldIndex), {
      ...candidate,
      startMs: now,
    });
  }

  getMeldOffsetX(seat: number, meldIndex: number, distance: number): number {
    return this.getOffset(seat, meldIndex, distance, "meld");
  }

  getShouminkanOffsetY(
    seat: number,
    meldIndex: number,
    distance: number
  ): number {
    return this.getOffset(seat, meldIndex, distance, "shouminkan");
  }

  private getOffset(
    seat: number,
    meldIndex: number,
    distance: number,
    kind: MeldAnimation["kind"]
  ): number {
    const now = this.now();
    this.dropCompleted(now);
    const animation = this.animations.get(animationKey(seat, meldIndex));
    if (!animation || animation.kind !== kind) {
      return 0;
    }
    const linear = Math.max(
      0,
      Math.min(1, (now - animation.startMs) / MELD_SLIDE_DURATION_MS)
    );
    return -distance * (1 - easeOutCubic(linear));
  }

  hasActive(): boolean {
    this.dropCompleted(this.now());
    return this.animations.size > 0;
  }

  private dropCompleted(now: number): void {
    for (const [key, animation] of this.animations) {
      if (now - animation.startMs >= MELD_SLIDE_DURATION_MS) {
        this.animations.delete(key);
      }
    }
  }
}

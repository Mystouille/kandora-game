import type { GameEvent, Tile } from "../protocol/messages";

function emptyWaits(): Tile[][] {
  return [[], [], [], []];
}

function snapshot(waits: readonly Tile[][]): Tile[][] {
  return waits.map((tiles) => [...tiles]);
}

/**
 * Build replay-timeline wait snapshots using recorded event data only.
 * Legacy events without `discard.waits` remain empty; no shanten fallback runs.
 */
export function recordedWaitsByIndex(
  events: readonly GameEvent[]
): Tile[][][] {
  const result: Tile[][][] = new Array(events.length);
  let current = emptyWaits();

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    switch (event.type) {
      case "match_start":
      case "hand_start": {
        current = emptyWaits();
        break;
      }
      case "draw":
      case "call":
      case "flower":
      case "nuki":
      case "win": {
        current[event.seat] = [];
        break;
      }
      case "discard": {
        current[event.seat] = event.waits ? [...event.waits] : [];
        break;
      }
      case "hand_end": {
        if (event.waits !== undefined) {
          current = emptyWaits();
          event.waits.forEach((waits, seat) => {
            current[seat] = waits === null ? [] : [...waits];
          });
        }
        break;
      }
      default: {
        break;
      }
    }
    result[index] = snapshot(current);
  }

  return result;
}

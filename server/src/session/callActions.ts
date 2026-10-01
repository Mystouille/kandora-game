import type { LegalAction } from "~/game/protocol/messages";

import type { CallOption } from "~/game/rules";

export function callActionPriority(action: LegalAction): number {
  if (action.type === "ron") {
    return 4;
  }
  if (action.type === "kan") {
    return 3;
  }
  if (action.type === "pon") {
    return 2;
  }
  if (action.type === "chi") {
    return 1;
  }
  return 0;
}

export function callOptionsMaxPriority(options: CallOption[]): number {
  let best = 0;
  for (const o of options) {
    let p = 0;
    if (o.kind === "ron") {
      p = 4;
    } else if (o.kind === "daiminkan") {
      p = 3;
    } else if (o.kind === "pon") {
      p = 2;
    } else if (o.kind === "chi") {
      p = 1;
    }
    if (p > best) {
      best = p;
    }
  }
  return best;
}

export function buildCallLegals(options: CallOption[]): LegalAction[] {
  const out: LegalAction[] = [];
  let i = 0;
  for (const opt of options) {
    if (opt.kind === "chi") {
      out.push({
        id: `chi:${i++}:${opt.tiles.join(",")}`,
        type: "chi",
        tiles: [...opt.tiles],
      });
    } else if (opt.kind === "pon") {
      out.push({
        id: `pon:${i++}:${opt.tiles.join(",")}`,
        type: "pon",
        tiles: [...opt.tiles],
      });
    } else if (opt.kind === "daiminkan") {
      out.push({
        id: `kan:${i++}:${opt.tiles.join(",")}`,
        type: "kan",
        tiles: [...opt.tiles],
        kanKind: "daiminkan",
      });
    } else if (opt.kind === "ron") {
      out.push({ id: `ron:${i++}`, type: "ron" });
    }
  }
  out.push({ id: "pass", type: "pass" });
  return out;
}

export function cloneCallOption(option: CallOption): CallOption {
  if (option.kind === "ron") {
    return { kind: "ron" };
  }
  if (option.kind === "daiminkan") {
    return {
      kind: "daiminkan",
      tiles: [option.tiles[0], option.tiles[1], option.tiles[2]],
    };
  }
  return { kind: option.kind, tiles: [option.tiles[0], option.tiles[1]] };
}

export function cloneLegalAction(action: LegalAction): LegalAction {
  return { ...action, ...(action.tiles ? { tiles: [...action.tiles] } : {}) };
}

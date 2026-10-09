import Riichi from "riichi";

export interface RiichiRaw {
  isAgari: boolean;
  yakuman: number;
  yaku: Record<string, string>;
  han: number;
  fu: number;
  ten: number;
  name: string;
  text: string;
  oya: number[];
  ko: number[];
  error: boolean;
}

interface RiichiScorer {
  tmpResult: RiichiRaw;
  currentPattern: readonly (string | readonly string[])[];
  agari: string;
  bakaze: number;
  jikaze: number;
  isTsumo: boolean;
  isMenzen(): boolean;
  calcYaku(): void;
  calcFu(): void;
  calcDora(): void;
  calcTen(): void;
  calc(): RiichiRaw;
  disableKuitan(): void;
  disableAka(): void;
}

export interface RiichiAdapterOptions {
  doubleWindPairFu?: 2 | 4;
  noKuitan?: boolean;
  noAka?: boolean;
  /** A declared sanma replacement win, even without a kan or with Kansai ippatsu. */
  rinshan?: boolean;
  /** Treat a completed North set as a one-han Kansai value honor. */
  kansaiNorthYakuhai?: boolean;
  nukiDora?: number;
  nukiIndicatorDora?: number;
  nukiAkaDora?: number;
  priceCandidate?: (candidate: RiichiRaw) => void;
}

function isTerminalOrHonor(tile: string): boolean {
  return (
    tile.length === 2 && (tile[0] === "1" || tile[0] === "9" || tile[1] === "z")
  );
}

function calculateFu(scorer: RiichiScorer, doubleWindPairFu: 2 | 4): void {
  let fu = 0;
  if (scorer.tmpResult.yaku["七対子"]) {
    fu = 25;
  } else if (scorer.tmpResult.yaku["平和"]) {
    fu = scorer.isTsumo ? 20 : 30;
  } else {
    fu = 20;
    let hasAgariFu = false;
    if (!scorer.isTsumo && scorer.isMenzen()) {
      fu += 10;
    }
    for (const group of scorer.currentPattern) {
      if (typeof group === "string") {
        if (group.includes("z")) {
          const honor = Number.parseInt(group, 10);
          if (
            doubleWindPairFu === 2 &&
            honor === scorer.bakaze &&
            honor === scorer.jikaze
          ) {
            fu += 2;
          } else {
            for (const valueHonor of [scorer.bakaze, scorer.jikaze, 5, 6, 7]) {
              if (honor === valueHonor) {
                fu += 2;
              }
            }
          }
        }
        if (scorer.agari === group) {
          hasAgariFu = true;
        }
      } else if (group.length === 4) {
        fu += isTerminalOrHonor(group[0]) ? 16 : 8;
      } else if (group.length === 2) {
        fu += isTerminalOrHonor(group[0]) ? 32 : 16;
      } else if (group.length === 1) {
        fu += isTerminalOrHonor(group[0]) ? 8 : 4;
      } else if (group.length === 3 && group[0] === group[1]) {
        fu += isTerminalOrHonor(group[0]) ? 4 : 2;
      } else if (!hasAgariFu) {
        // riichi@1.2.0 compares the edge tiles to a boolean, not the win tile.
        if (
          group[1] === scorer.agari ||
          (group[0] === scorer.agari && Number.parseInt(group[2], 10) === 9) ||
          (group[2] === scorer.agari && Number.parseInt(group[0], 10) === 1)
        ) {
          hasAgariFu = true;
        }
      }
    }
    if (hasAgariFu) {
      fu += 2;
    }
    if (scorer.isTsumo) {
      fu += 2;
    }
    fu = Math.max(30, Math.ceil(fu / 10) * 10);
  }
  scorer.tmpResult.fu = fu;
}

function addHan(result: RiichiRaw, name: string, count: number): void {
  if (count <= 0) {
    return;
  }
  const previous = Number.parseInt(result.yaku[name] ?? "0", 10);
  result.han += count;
  result.yaku[name] = `${previous + count}飜`;
}

/**
 * The library's declarations omit its candidate hooks and incorrectly fix
 * payment arrays to three entries. Keep that compatibility boundary here;
 * never change its prototype or add nuki to its hand/meld representation.
 */
export function createRiichiScorer(
  input: string,
  options: RiichiAdapterOptions = {}
): RiichiScorer {
  const scorer = new Riichi(input) as unknown as RiichiScorer;
  if (options.noKuitan) {
    scorer.disableKuitan();
  }
  if (options.noAka) {
    scorer.disableAka();
  }
  scorer.calcFu = () => calculateFu(scorer, options.doubleWindPairFu ?? 4);

  const addRinshan = options.rinshan && scorer.isTsumo;
  if (addRinshan || options.kansaiNorthYakuhai) {
    const calculateYaku = scorer.calcYaku.bind(scorer);
    scorer.calcYaku = () => {
      calculateYaku();
      const candidate = scorer.tmpResult;
      if (candidate.yakuman > 0) {
        return;
      }
      if (addRinshan && !candidate.yaku["嶺上開花"]) {
        // The library requires a kan and rejects ippatsu here. Nuki replacements
        // have neither restriction; rinshan must qualify before bonus counting.
        addHan(candidate, "嶺上開花", 1);
      }
      if (options.kansaiNorthYakuhai) {
        addHan(candidate, "北", 1);
      }
    };
  }

  const calculateDora = scorer.calcDora.bind(scorer);
  scorer.calcDora = () => {
    const candidate = scorer.tmpResult;
    if (candidate.yakuman > 0 || candidate.han === 0) {
      return;
    }
    calculateDora();
    addHan(candidate, "抜きドラ", options.nukiDora ?? 0);
    addHan(candidate, "ドラ", options.nukiIndicatorDora ?? 0);
    if (!options.noAka) {
      addHan(candidate, "赤ドラ", options.nukiAkaDora ?? 0);
    }
  };

  const priceCandidate = options.priceCandidate;
  if (priceCandidate) {
    const calculateTen = scorer.calcTen.bind(scorer);
    scorer.calcTen = () => {
      calculateTen();
      // calc() compares tmpResult.ten before breaking ties with han.
      priceCandidate(scorer.tmpResult);
    };
  }
  return scorer;
}

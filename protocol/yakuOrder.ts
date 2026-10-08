import { sortYakuNames as sortCoreYakuNames } from "~/core/mahjong/protocol/yakuOrder";

export * from "~/core/mahjong/protocol/yakuOrder";

const NUKI_NAMES = new Set(["nuki dora", "kita", "北", "抜きドラ", "ヌキドラ"]);

export function sortYakuNames(names: readonly string[]): string[] {
  const ordinary: string[] = [];
  const nuki: string[] = [];
  for (const name of names) {
    (NUKI_NAMES.has(name.toLowerCase()) ? nuki : ordinary).push(name);
  }
  return [...sortCoreYakuNames(ordinary), ...nuki];
}

export function sortYakuRecord(
  yaku: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    sortYakuNames(Object.keys(yaku)).map((name) => [name, yaku[name]])
  );
}

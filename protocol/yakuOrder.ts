/**
 * Canonical sort order for the yaku list in a `win` event.
 *
 * Win events carry `yaku` as `Record<string, string>` keyed by a
 * display name. The producer is one of:
 *   - Majsoul / Tenhou / Riichi City adapters → romaji from
 *     `hanRomaji(Han)` (e.g. "Riichi", "Sanshoku Doujun").
 *   - Internal scorer (`riichi` npm package) → Japanese kanji
 *     (e.g. "立直", "三色同順").
 *
 * Both forms are normalized back to a `Han` enum value via
 * {@link NAME_TO_HAN}; the priority tables are pure `Han[]` so
 * matching is exact rather than string-search based. Names that
 * don't resolve to a known `Han` keep their original insertion
 * order in a neutral middle bucket.
 *
 * Modern JS preserves insertion order of string keys, so applying
 * this sort once at event-emit time means every downstream
 * consumer (replay log, in-game win-info panel, exporters) sees
 * the same order without re-sorting.
 */
import { Han } from "~/api/majsoul/data/types/enums/Han";
import { HAN_ROMAJI } from "~/i18n/hanRomaji";

/** Display kanji emitted by the `riichi` npm package for the
 *  yaku referenced by the priority tables. Only entries needed
 *  for sorting are listed — unknown names fall back to the
 *  neutral middle bucket. */
const HAN_KANJI: Partial<Record<Han, readonly string[]>> = {
  [Han.Riichi]: ["立直"],
  [Han.Double_Riichi]: ["両立直", "ダブル立直"],
  [Han.Ippatsu]: ["一発"],
  [Han.Robbing_a_Kan]: ["搶槓", "槍槓"],
  [Han.After_a_Kan]: ["嶺上開花"],
  [Han.Under_the_Sea]: ["海底摸月"],
  [Han.Under_the_River]: ["河底撈魚"],
  [Han.Pinfu]: ["平和"],
  [Han.All_Simples]: ["断么九", "断幺九", "タンヤオ"],
  [Han.Pure_Straight]: ["一気通貫"],
  [Han.Mixed_Triple_Sequence]: ["三色同順"],
  [Han.Triple_Triplets]: ["三色同刻"],
  [Han.Pure_Double_Sequence]: ["一盃口"],
  [Han.Dora]: ["ドラ"],
  [Han.Red_Five]: ["赤ドラ", "赤"],
  [Han.Ura_Dora]: ["裏ドラ"],
  [Han.Kita]: ["北", "抜きドラ", "ヌキドラ"],
};

/** Display-name → `Han` lookup, populated from `HAN_ROMAJI` (the
 *  canonical adapter display table) and `HAN_KANJI` (the scorer
 *  output). Keys are lowercased. */
const NAME_TO_HAN: ReadonlyMap<string, Han> = (() => {
  const map = new Map<string, Han>();
  for (const [hanStr, name] of Object.entries(HAN_ROMAJI)) {
    map.set(name.toLowerCase(), Number(hanStr) as Han);
  }
  for (const [hanStr, aliases] of Object.entries(HAN_KANJI)) {
    if (!aliases) {
      continue;
    }
    for (const a of aliases) {
      map.set(a.toLowerCase(), Number(hanStr) as Han);
    }
  }
  return map;
})();

/** Yaku pinned to the top of the list, in this exact order. Each
 *  entry is a group of `Han` values that share the same priority
 *  slot (e.g. riichi + double riichi). Within a slot, original
 *  insertion order is preserved. */
const YAKU_PRIORITY_FIRST: readonly (readonly Han[])[] = [
  [Han.Riichi, Han.Double_Riichi],
  [Han.Ippatsu],
  [Han.Robbing_a_Kan],
  [Han.After_a_Kan],
  [Han.Under_the_Sea, Han.Under_the_River],
  [Han.Pinfu],
  [Han.All_Simples],
  [Han.Pure_Straight],
  [Han.Mixed_Triple_Sequence, Han.Triple_Triplets],
  [Han.Pure_Double_Sequence],
];

/** Yaku pinned to the bottom of the list, in this exact order. */
const YAKU_PRIORITY_LAST: readonly (readonly Han[])[] = [
  [Han.Dora],
  [Han.Red_Five],
  [Han.Ura_Dora],
  [Han.Kita],
];

/** `Han` → numeric sort key. Negative for the first list,
 *  positive for the last list, undefined for the neutral middle. */
const HAN_ORDER: ReadonlyMap<Han, number> = (() => {
  const map = new Map<Han, number>();
  YAKU_PRIORITY_FIRST.forEach((group, i) => {
    for (const han of group) {
      map.set(han, -YAKU_PRIORITY_FIRST.length + i);
    }
  });
  YAKU_PRIORITY_LAST.forEach((group, i) => {
    for (const han of group) {
      map.set(han, 1000 + i);
    }
  });
  return map;
})();

/**
 * Stable sort: first list at the top (in the listed order), last
 * list at the bottom (in the listed order), everything else stays
 * in its original insertion order between the two.
 */
export function sortYakuNames(names: readonly string[]): string[] {
  const orderOf = (name: string): number => {
    const han = NAME_TO_HAN.get(name.toLowerCase());
    if (han === undefined) {
      return 0;
    }
    return HAN_ORDER.get(han) ?? 0;
  };
  return [...names]
    .map((name, idx) => ({ name, idx, order: orderOf(name) }))
    .sort((a, b) => a.order - b.order || a.idx - b.idx)
    .map((entry) => entry.name);
}

/**
 * Return a new `yaku` record with keys reordered per
 * {@link sortYakuNames}. Values are copied verbatim.
 */
export function sortYakuRecord(
  yaku: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of sortYakuNames(Object.keys(yaku))) {
    out[key] = yaku[key];
  }
  return out;
}

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
 * Both forms are matched through explicit alias groups. Names that don't
 * resolve to a known group keep their original insertion order in a neutral
 * middle bucket.
 *
 * Modern JS preserves insertion order of string keys, so applying
 * this sort once at event-emit time means every downstream
 * consumer (replay log, in-game win-info panel, exporters) sees
 * the same order without re-sorting.
 */
/** Yaku pinned to the top of the list, in this exact order. Each
 *  entry is a group of aliases that share the same priority
 *  slot (e.g. riichi + double riichi). Within a slot, original
 *  insertion order is preserved. */
const YAKU_PRIORITY_FIRST: readonly (readonly string[])[] = [
  ["Riichi", "Daburu Riichi", "立直", "両立直", "ダブル立直"],
  ["Ippatsu", "一発"],
  ["Tsumo", "門前清自摸和"],
  ["Chankan", "搶槓", "槍槓"],
  ["Rinshan Kaihou", "嶺上開花"],
  ["Haitei Raoyue", "Houtei Raoyui", "海底摸月", "河底撈魚"],
  ["Pinfu", "平和"],
  ["Tanyao", "断么九", "断幺九", "タンヤオ"],
  ["Ittsu", "一気通貫"],
  ["Sanshoku Doujun", "Sanshoku Doukou", "三色同順", "三色同刻"],
  ["Iipeikou", "一盃口"],
];

/** Yaku pinned to the bottom of the list, in this exact order. */
const YAKU_PRIORITY_LAST: readonly (readonly string[])[] = [
  ["Dora", "ドラ"],
  ["Aka Dora", "赤ドラ", "赤"],
  ["Ura Dora", "裏ドラ"],
  ["Kita", "北", "抜きドラ", "ヌキドラ"],
];

/** Alias → numeric sort key. Negative for the first list,
 *  positive for the last list, undefined for the neutral middle. */
const NAME_ORDER: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  YAKU_PRIORITY_FIRST.forEach((group, i) => {
    for (const name of group) {
      map.set(name.toLowerCase(), -YAKU_PRIORITY_FIRST.length + i);
    }
  });
  YAKU_PRIORITY_LAST.forEach((group, i) => {
    for (const name of group) {
      map.set(name.toLowerCase(), 1000 + i);
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
  const orderOf = (name: string): number =>
    NAME_ORDER.get(name.toLowerCase()) ?? 0;
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

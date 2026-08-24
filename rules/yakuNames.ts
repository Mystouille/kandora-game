/**
 * Display names for yaku keys emitted by the `riichi` npm package.
 *
 * Keeping this table in the rules package makes scorer output portable across
 * the Node server and mobile host without depending on a portal-owned enum or
 * localization module.
 */
export const RIICHI_LIB_YAKU_ROMAJI: Readonly<Record<string, string>> = {
  立直: "Riichi",
  ダブル立直: "Daburu Riichi",
  一発: "Ippatsu",
  門前清自摸和: "Tsumo",
  搶槓: "Chankan",
  嶺上開花: "Rinshan Kaihou",
  海底摸月: "Haitei Raoyue",
  河底撈魚: "Houtei Raoyui",
  平和: "Pinfu",
  断么九: "Tanyao",
  一気通貫: "Ittsu",
  一盃口: "Iipeikou",
  三色同順: "Sanshoku Doujun",
  三色同刻: "Sanshoku Doukou",
  三槓子: "Sankantsu",
  対々和: "Toitoi",
  三暗刻: "Sanankou",
  小三元: "Shousangen",
  混老頭: "Honroutou",
  七対子: "Chiitoitsu",
  混全帯么九: "Chanta",
  純全帯么九: "Junchan",
  混一色: "Honitsu",
  二盃口: "Ryanpeikou",
  清一色: "Chinitsu",
  場風東: "Bakaze",
  場風南: "Bakaze",
  場風西: "Bakaze",
  場風北: "Bakaze",
  自風東: "Jikaze",
  自風南: "Jikaze",
  自風西: "Jikaze",
  自風北: "Jikaze",
  役牌白: "Haku",
  役牌発: "Hatsu",
  役牌中: "Chun",
  天和: "Tenhou",
  地和: "Chiihou",
  人和: "Renhou",
  国士無双: "Kokushi Musou",
  国士無双十三面待ち: "Kokushi Juusanmen Machi",
  四暗刻: "Suuankou",
  四暗刻単騎待ち: "Suuankou Tanki",
  大三元: "Daisangen",
  小四喜: "Shousuushii",
  大四喜: "Daisuushii",
  字一色: "Tsuuiisou",
  緑一色: "Ryuuiisou",
  清老頭: "Chinroutou",
  四槓子: "Suukantsu",
  九蓮宝燈: "Chuuren Poutou",
  純正九蓮宝燈: "Junsei Chuuren Poutou",
  大七星: "Dai Shichisei",
  ドラ: "Dora",
  赤ドラ: "Aka Dora",
  裏ドラ: "Ura Dora",
};

interface TenhouYakuDescriptor {
  romaji: string;
  /** Numeric value retained for the legacy `yakuHan` statistics field. */
  legacyHan: number;
}

export const TENHOU_YAKU: Readonly<
  Partial<Record<number, TenhouYakuDescriptor>>
> = {
  0: { romaji: "Tsumo", legacyHan: 1 },
  1: { romaji: "Riichi", legacyHan: 2 },
  2: { romaji: "Ippatsu", legacyHan: 30 },
  3: { romaji: "Chankan", legacyHan: 3 },
  4: { romaji: "Rinshan Kaihou", legacyHan: 4 },
  5: { romaji: "Haitei Raoyue", legacyHan: 5 },
  6: { romaji: "Houtei Raoyui", legacyHan: 6 },
  7: { romaji: "Pinfu", legacyHan: 14 },
  8: { romaji: "Tanyao", legacyHan: 12 },
  9: { romaji: "Iipeikou", legacyHan: 13 },
  10: { romaji: "Jikaze", legacyHan: 10 },
  11: { romaji: "Jikaze", legacyHan: 10 },
  12: { romaji: "Jikaze", legacyHan: 10 },
  13: { romaji: "Jikaze", legacyHan: 10 },
  14: { romaji: "Bakaze", legacyHan: 11 },
  15: { romaji: "Bakaze", legacyHan: 11 },
  16: { romaji: "Bakaze", legacyHan: 11 },
  17: { romaji: "Bakaze", legacyHan: 11 },
  18: { romaji: "Haku", legacyHan: 7 },
  19: { romaji: "Hatsu", legacyHan: 8 },
  20: { romaji: "Chun", legacyHan: 9 },
  21: { romaji: "Daburu Riichi", legacyHan: 18 },
  22: { romaji: "Chiitoitsu", legacyHan: 25 },
  23: { romaji: "Chanta", legacyHan: 15 },
  24: { romaji: "Ittsu", legacyHan: 16 },
  25: { romaji: "Sanshoku Doujun", legacyHan: 17 },
  26: { romaji: "Sanshoku Doukou", legacyHan: 19 },
  27: { romaji: "Sankantsu", legacyHan: 20 },
  28: { romaji: "Toitoi", legacyHan: 21 },
  29: { romaji: "Sanankou", legacyHan: 22 },
  30: { romaji: "Shousangen", legacyHan: 23 },
  31: { romaji: "Honroutou", legacyHan: 24 },
  32: { romaji: "Ryanpeikou", legacyHan: 28 },
  33: { romaji: "Junchan", legacyHan: 26 },
  34: { romaji: "Honitsu", legacyHan: 27 },
  35: { romaji: "Chinitsu", legacyHan: 29 },
  36: { romaji: "Tenhou", legacyHan: 35 },
  37: { romaji: "Chiihou", legacyHan: 36 },
  38: { romaji: "Daisangen", legacyHan: 37 },
  39: { romaji: "Suuankou", legacyHan: 38 },
  40: { romaji: "Suuankou Tanki", legacyHan: 48 },
  41: { romaji: "Tsuuiisou", legacyHan: 39 },
  42: { romaji: "Ryuuiisou", legacyHan: 40 },
  43: { romaji: "Chinroutou", legacyHan: 41 },
  44: { romaji: "Chuuren Poutou", legacyHan: 45 },
  45: { romaji: "Junsei Chuuren Poutou", legacyHan: 47 },
  46: { romaji: "Kokushi Musou", legacyHan: 42 },
  47: { romaji: "Kokushi Juusanmen Machi", legacyHan: 49 },
  48: { romaji: "Shousuushii", legacyHan: 43 },
  49: { romaji: "Daisuushii", legacyHan: 50 },
  50: { romaji: "Suukantsu", legacyHan: 44 },
  52: { romaji: "Dora", legacyHan: 31 },
  53: { romaji: "Ura Dora", legacyHan: 33 },
  54: { romaji: "Aka Dora", legacyHan: 32 },
};

export const RIICHI_LIB_YAKU_KANJI_BY_ROMAJI: Readonly<
  Record<string, string>
> = Object.fromEntries(
  Object.entries(RIICHI_LIB_YAKU_ROMAJI).map(([kanji, romaji]) => [
    romaji,
    kanji,
  ])
);

export function tenhouYakuIdToRomaji(id: number): string | undefined {
  return TENHOU_YAKU[id]?.romaji;
}

export function tenhouYakuIdToLegacyHan(id: number): number | undefined {
  return TENHOU_YAKU[id]?.legacyHan;
}

export function riichiLibYakuToRomaji(
  yaku: Record<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(yaku)) {
    normalized[RIICHI_LIB_YAKU_ROMAJI[name] ?? name] = value;
  }
  return normalized;
}
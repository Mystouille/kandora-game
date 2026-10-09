# Standalone MCR scoring compatibility

## Contract and scope

`rules/scoring/mcr` is an isolated, four-player Mahjong Competition Rules
scoring slice. It is not exported from the central game rules and is not wired
to the match engine yet.

The public entry points are:

- `scoreMcr(input)` — scores a Kandora `Tile`/`Meld`-shaped hand.
- `settleMcrWin(input)` — returns four zero-sum seat deltas.
- `MCR_FANS` / `MCR_FAN_IDS` — stable string IDs, English names, and values for
  all 81 fans.

`scoreMcr` accepts the concealed hand before the winning tile, the separate
winning tile, fixed melds, and a win context. The context distinguishes discard
and self-draw wins, prevalent and seat winds, flowers, last wall draw/claim,
last physical copy, kong replacement, and robbing a promoted kong.

Every awarded fan reports:

- stable ID and English name;
- Green Book value for one occurrence;
- awarded count;
- awarded point subtotal.

The score also reports `totalFan`, `nonFlowerFan`, and `meetsMinimum`.
Flowers are included in `totalFan` but excluded from `nonFlowerFan`, so they
never satisfy the eight-point minimum.

## Normative rules profile

The normative rules reference is the EMA English translation, **Mahjong
Competition Rules — The Green Book, 2006**. In particular:

- Two Concealed Kongs is eight points.
- One concealed kong plus one melded kong is the six-point clause represented
  by a single Two Melded Kongs award with a six-point subtotal.
- Chicken Hand is awarded only when the selected interpretation has zero
  non-flower fan before Chicken Hand.
- Candidate normalization happens before choosing the highest-valued
  decomposition.
- non-repeat, non-separation, non-identical, high-versus-low, and account-once
  constraints are applied while combinations are formed, rather than by
  summing every matching pattern independently.

The scorer retains the pinned implementation's deterministic decomposition
order and correction preferences. Candidate ties therefore do not depend on
object iteration order.

## Source compatibility and exclusions

The fan calculator is a TypeScript port of
`SkyEye-FAST/mcr-mahjong` tag `v0.1.0`, commit
`7d772b66adcf0e8316123f66b350c5cb9d71a7ca`. That project is itself a Kotlin
port of Jeff Wang / summerinsects `mahjong-algorithm`, pinned at commit
`44a178af08bf11f82a8993fddbe2fe8876ddd8f3`.

The pinned scorer is used for decomposition and combination mechanics. The
public normalization layer applies the Green Book corrections above, including
the concealed-kong series, mandatory fully-concealed combinations, All Green
flush combination, and corrected competing-decomposition valuation.

No JVM or C++ shanten implementation is included. `scoreMcr` first delegates
structural qualification to
`isMcrWinningShape` from `~/core/mahjong/rules/mcrShanten`.

The slice deliberately does not provide:

- central exports or engine/protocol/client integration;
- flower-tile wall handling;
- match progression or liability rules;
- blessings or non-EMA house-rule extensions.

## Settlement

Settlement is pure and zero-sum:

- self-draw: every opponent pays `totalFan + 8`;
- discard win: the discarder pays `totalFan + 8`, and each other opponent pays 8.

Settlement rejects a result below eight non-flower points. Flower points are
included in payment only after the non-flower minimum has been met.

## Regression evidence

Focused Vitest fixtures translate the pinned project's independent standard and
correction cases. Coverage includes the mixed-kong correction, concealed-kong
series, knitted forms and residual waits, corrected competing decompositions,
Chicken Hand, flower/minimum behavior, all 81 fan values, and both settlement
methods.

# Sanma

## Setup and supported hosts

Enable **3-player** and select **Online** or **Kansai**. The toggle defaults to
off; its initial variant is Online. The ordinary preset selector is disabled
while sanma is selected and its previous four-player selection is restored
when the toggle is disabled.

Sanma uses the M-League base with these changes:

- Three players, three hands per wind, East + South, and no chii.
- No head-bump: both opponents may ron. The existing multi-ron deposit policy
  applies.
- The variant tile, nuki, wall, and payment rules below.

Other defaults remain M-League: 45,000 starting points, no bankruptcy or
abortive draws, no nagashi mangan, normal dealer continuation, 1,000-point
riichi, one red 5p/5s, and ordinary ippatsu/ura. Honba adds 300 on ron or
100 from each actual tsumo payer. The 3,000-point noten pool is shared among
the actual participants; all-tenpai and all-noten have no transfer.

The same setup works for web/mobile rooms, solo with two bots, mobile local
play, Nearby hosting, and Duplicate. Native spectating, reconnect, pause/resume,
and replay/review retain the variant. Spectators keep the existing all-hands
visibility and configured delay; seated players do not receive opponents'
concealed replacement tiles.

Sanma+Buu, three-player tournament scheduling/UMA settlement, and new external
sanma import/relay/export formats are outside this implementation. Native
results use raw points and three placements. Unsupported Tenhou/Naga conversion
fails explicitly; native replay/share remains available.

## Tiles and nuki

| Rule | Online | Kansai |
|---|---|---|
| Tile count | 108 | 112 |
| Removed manzu | 2m-8m | 2m-4m and 6m-8m |
| Nuki | North, optional | Every 5m/0m, automatic |
| Ordinary use | North may remain in the hand or a pon/kan | 5m never remains in a playable hand or meld |
| Manzu dora cycle | 1m -> 9m -> 1m | 1m -> 5m -> 9m -> 1m |
| Red 5m | Absent | The M-League red 5m is retained |

In Kansai, a North triplet or kan is always a one-han qualifying yaku.

An extracted tile gives one nuki bonus han plus any applicable indicator,
ura, and red-five bonuses. Nuki is not itself a qualifying yaku, does not
open the hand, and is separate from melds. Ordinary yakuman handling ignores
bonus han. A tile used as an indicator is not a player extraction.

### Online North

- Extraction is an explicit choice on the player's own draw turn, including
  replacement draws; it is not allowed immediately after pon without a draw.
- After riichi, only a just-drawn North may be extracted.
- Declaration interrupts ippatsu and uninterrupted first-turn eligibility,
  but does not revoke an already established double-riichi declaration.
- Any otherwise legal hand may rob the declared North, with chankan awarded.
  Every eligible human receives a ron/pass choice; normal furiten applies.
- The replacement and nuki bonus are committed only after the ron window
  closes. A robbed extraction consumes neither.

### Kansai 5m

Every dealt or drawn 5m/0m is extracted automatically, including opening hands
and consecutive replacements. Opening hands are normalized before ordinary
turn choices. Extraction itself does not interrupt ippatsu or first-turn
eligibility; a preceding kan still has its usual effect.

Both variants award rinshan on a nuki replacement win, including Duplicate.
Such a replacement is not also haitei. Nuki never reveals another indicator
or consumes a kan slot. A hand has at most four kans and its four physical
nuki tiles.

## Payments

Online retains ordinary han/fu valuation, including the M-League kiriage
setting. Ron is unchanged; tsumo collects only the two actual opponents'
payments. Published hand totals reflect those actual payments.

Kansai ignores fu, including when choosing between winning decompositions.
Use the following table literally. Non-dealer tsumo is listed as
**other non-dealer / dealer**.

| Han / tier | Dealer ron | Dealer tsumo, each | Non-dealer ron | Non-dealer tsumo |
|---|---:|---:|---:|---:|
| 1 | 2,000 | 1,000 | 1,000 | 1,000 / 1,000 |
| 2 | 3,000 | 2,000 | 2,000 | 1,000 / 1,000 |
| 3 | 6,000 | 3,000 | 4,000 | 1,000 / 3,000 |
| 4-5: mangan | 12,000 | 6,000 | 8,000 | 3,000 / 5,000 |
| 6-7: haneman | 18,000 | 9,000 | 12,000 | 4,000 / 8,000 |
| 8-10: baiman | 24,000 | 12,000 | 16,000 | 6,000 / 10,000 |
| 11-12: sanbaiman | 36,000 | 18,000 | 24,000 | 8,000 / 16,000 |
| 13+ / one yakuman | 48,000 | 24,000 | 32,000 | 12,000 / 20,000 |

The unusual low-han differences between ron and total tsumo are intentional.
True multiple yakuman scale the yakuman row; ordinary 13+ han uses its single
counted-yakuman band. Existing honba, deposits, and responsibility bookkeeping
apply only to the three participants.

## Standard walls

These counts are after three 13-tile hands, before the dealer's ordinary draw.

| Variant | Initial live | Initial dead | Replacement capacity | Live change per kan | Live change per nuki |
|---|---:|---:|---:|---:|---:|
| Online | 55 | 14 | 8 | -1 | -1 |
| Kansai | 63 | 10 | 8 | -2 | 0 |

Online replenishes every replacement from the live tail and always keeps
14 unconsumed dead-wall tiles. Its eight replacement positions do not imply
an 18-tile permanent reserve.

Kansai starts with eight replacements and the first dora/ura pair. Nuki
shrinks the dead wall by one. A kan consumes a replacement and reserves
the next two indicator tiles from the live tail, growing the reserve by
one overall. Future indicator pairs are drawable until reserved.

Explicit cursors preserve indicator identities across mixed kan/nuki sequences.
Declarations cannot consume indicators, exceed replacement capacity, or overrun
the required live-tail boundary.

### Duplicate is different

Both variants retain Duplicate's fixed 14-tile reserve: four unused physical
replacement tiles and all five preselected indicator pairs.

Kan/nuki replacements consume the acting player's next personal-queue tile.
They do not remove another player's queued tiles or repartition the queues.
Before opening extraction, Online has dealer-relative queues of 19/18/18;
Kansai has 20/20/19. A mandatory Kansai extraction with no queued replacement
ends cleanly in an exhaustive draw.

Existing four-player generation-version-1 boards remain unchanged.

## Layout and compatibility

Logical participants are initial East/South/West. From initial East's view,
they occupy bottom/right/top, with the left player position empty throughout
the match. Other perspectives rotate that same physical gap; dealer changes
do not move it. Standard walls remain four-sided. Extracted tiles have a
separate public strip, not an extra meld.

Engine/protocol/replay collections contain three participants. The renderer's
four physical slots are a separate projection with an explicit empty position.

Online and Nearby negotiate `sanma-v1`; incompatible players or spectators
receive an update-required error before receiving a three-player game.
Checkpoint version 8 supports North-ron decisions and interrupted mandatory
replacements. Supported versions 1-7 remain readable for existing games.
Native replay schema version 10 records the effective variant and nuki events.

## Validation

The host's existing Vitest suite covers literal scoring cells and thresholds,
wall conservation, nuki legality/robbery, three-seat sessions, deterministic
Duplicate queues, checkpoint recovery, replay folds, and four-player regressions.
`npm run test:e2e -- sanma.e2e.ts` exercises all four variant/mode combinations
with authoritative game data, web perspectives, dealer rotation, and mobile
replay rendering. Physical Nearby radio verification requires actual devices.

# Cross-platform replay viewer — fidelity matrix

Phase 4.5 ships a single replay route at `/replays/:source/:gameId`
that renders a `ReplayLog` document through the same Pixi
`TableRenderer` used for live play. The reducer in
[player.ts](./player.ts) is platform-agnostic; per-platform
adapters under `app/api/<platform>/replayAdapter.ts` are the only
code that knows about a given platform's encoding.

This document declares, per feature × per source, whether the
adapter currently produces a faithful representation. It drives
test scope (only `full` features need byte-equality tests against
real fixtures) and sets user expectations on the replay UI.

## Sources

| Source          | Adapter                                                                        | Connector                                                                                    |
| --------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `ingame`        | `game-server/src/persist.ts` (`archiveReplayLog`)                              | n/a (engine-native)                                                                          |
| `majsoul`       | [`app/api/majsoul/replayAdapter.ts`](../../api/majsoul/replayAdapter.ts)       | [`MajsoulLeagueConnector`](../../services/connectors/MajsoulLeagueConnector.server.ts)       |
| `tenhou` (XML)  | [`app/api/tenhou/replayAdapter.ts`](../../api/tenhou/replayAdapter.ts)         | [`TenhouLeagueConnector`](../../services/connectors/TenhouLeagueConnector.server.ts)         |
| `tenhou` (JSON) | `parseTenhouJsonReplay` in the same file                                       | n/a yet (lobby fetch flow returns XML)                                                       |
| `riichicity`    | [`app/api/riichiCity/replayAdapter.ts`](../../api/riichiCity/replayAdapter.ts) | [`RiichiCityLeagueConnector`](../../services/connectors/RiichiCityLeagueConnector.server.ts) |

Status legend:

- **full** — adapter produces a byte-equivalent event stream when
  re-played through the engine (final scores + win events match the
  platform's reported scores).
- **partial** — feature is surfaced but with documented caveats
  (e.g. heuristic discriminant, placeholder value, missing flag).
- **not-supported** — feature is dropped on parse; viewer will not
  render it. Always documented with a reason.

## Feature matrix

| Feature                               | ingame | majsoul         | tenhou (XML)    | tenhou (JSON)   | riichicity      |
| ------------------------------------- | ------ | --------------- | --------------- | --------------- | --------------- |
| Red fives (`0m`/`0p`/`0s`)            | full   | full            | full            | full            | full            |
| `startingHands` (omniscient archival) | full   | full            | full            | full            | full            |
| Discards — riichi flag                | full   | full            | full            | full            | full            |
| Discards — tsumogiri flag             | full   | full            | not-supported¹  | full            | full            |
| Calls — chi / pon / daiminkan         | full   | full            | full            | full            | full            |
| Calls — ankan / shouminkan            | full   | full            | full            | full            | partial²        |
| `wallRemaining` per draw              | full   | full            | not-supported³  | not-supported³  | not-supported³  |
| `new_dora` mid-hand kan-flip          | full   | full            | full            | full            | full            |
| Single ron                            | full   | full            | full            | full            | full            |
| Multi-ron (single `hand_end` summary) | full   | full            | full            | full            | partial⁴        |
| Tsumo                                 | full   | full            | full            | full            | full            |
| Ura-dora reveal on riichi win         | full   | full            | full            | full            | partial⁵        |
| `winTile` on win event                | full   | full            | full            | full            | partial⁶        |
| `han` / `fu` / `ten` on win event     | full   | full            | full            | full            | full            |
| Exhaustive draw — tenpai flags        | full   | full            | partial⁷        | partial⁷        | partial⁷        |
| Exhaustive draw — nagashi mangan      | full   | not-supported⁸  | not-supported⁸  | not-supported⁸  | not-supported⁸  |
| Abort — kyuushuu kyuuhai              | full   | full            | full            | full            | partial⁹        |
| Abort — suufon-renda                  | full   | full            | full            | full            | partial⁹        |
| Abort — suucha riichi                 | full   | full            | full            | full            | partial⁹        |
| Abort — sanchahou (triple ron)        | full   | full            | full            | full            | partial⁹        |
| Chankan                               | full   | full            | full            | full            | full            |
| Double riichi                         | full   | full            | full            | full            | full            |
| Paarenchan                            | full   | full            | full            | full            | full            |
| Honba / riichi-stick carry            | full   | full            | full            | full            | full            |
| Final-standings placements            | full   | full            | full            | full            | full            |
| 3-player (sanma)                      | n/a    | not-supported¹⁰ | not-supported¹⁰ | not-supported¹⁰ | not-supported¹⁰ |

### Footnotes

1. **Tenhou XML tsumogiri** — the `<D…>/<E…>/<F…>/<G…>` discard
   tags don't carry a tsumogiri marker; deriving it requires
   comparing each discard's tile id with the immediately preceding
   draw's tile id. Left for a follow-up pass; the discard event is
   emitted with `tsumogiri: false` regardless.

2. **Riichi City ankan vs shouminkan** — both share `ActionType.Minkan`
   in the wire payload. The adapter discriminates shouminkan via the
   `is_gang_incard` flag and the `bu_gang_cards` array. Edge cases
   where neither flag is set (rare; observed only on legacy logs)
   fall back to `daiminkan`.

3. **`wallRemaining` per draw** — Tenhou (both XML and JSON) and
   Riichi City don't tag the remaining wall count on individual
   draw events. The replay reducer still works (the wall count is
   only used by the HUD); `wallRemaining: 0` is the placeholder.
   Re-deriving from `(136 - 14 dead - dealer hand size - per-seat
draws/calls)` is a candidate enhancement.

4. **Riichi City multi-ron** — when two or three players ron the
   same discard, the adapter emits each `win` event with the same
   heuristic `loser` (the seat with the largest negative delta on
   the round). The combined `hand_end.delta` is exact; per-winner
   point attribution may not match Riichi City's display if the
   platform splits the discarder's loss differently from our
   heuristic.

5. **Riichi City ura-dora indicators** — the `WinInfoData.li_bao_card`
   array carries the ura indicators on riichi wins, but the
   `win` event currently leaves `uraDoraIndicators` undefined.
   The number of ura-dora-han is folded into `han` via the
   `YakuType.Ura` entry. Indicator tiles themselves are not
   surfaced on the result panel.

6. **Riichi City `winTile`** — left `undefined`. The platform
   reports the winning tile on the loser's `DiscardOrCall` event
   for ron and on the winner's last `Draw` for tsumo, but
   threading it through multi-ron streaks risks drift across the
   AGARI sequence. The reducer renders the win without a tile
   label until this is hardened with real fixtures.

7. **Tenpai flags at exhaustive draw** — Tenhou and Riichi City
   both expose tenpai through implicit signals (riichi declaration
   - `TenpaiReached` events on RC; `<RYUUKYOKU>` `sc` deltas on
     Tenhou). The adapter currently omits `hand_end.tenpai`; the UI
     shows the standard exhaustive-draw payouts and infers tenpai
     from the score delta. Not a correctness issue for the played-
     out hand; only the explicit per-seat flag is missing.

8. **Nagashi mangan** — only the in-app engine flags it explicitly.
   On the platform sources, a nagashi-mangan win lands as a normal
   `win` + `hand_end` with the right scores; the dedicated
   `hand_end.nagashi` flag isn't populated.

9. **Riichi City abort discrimination** — `RoundEndType` has
   `UnknownEndValue2..6` slots without a documented mapping to
   yao9 / kaze4 / reach4 / ron3. The adapter surfaces them as a
   generic `reason: "abort"` without setting `abortKind`. The
   in-app and other platforms' adapters set `abortKind` precisely.

10. **3-player (sanma)** — out of scope until the rules engine
    grows a 3p variant. The 4-seat reducer contract assumes
    `seats.length === 4`; sanma logs would need their own reducer.

## Adding a new feature row

1. Add the row above with the status flag for each source.
2. If `partial`, append a footnote explaining what's missing and
   the platform constraint.
3. Bump `REPLAY_LOG_SCHEMA_VERSION` in
   [`types.ts`](./types.ts) only if the on-disk shape changes —
   surface-level fidelity tweaks (e.g. setting a previously-`undefined`
   field) typically don't require a version bump unless they change
   byte-equality of the produced document.

## Adding a new source

1. Implement `app/api/<platform>/replayAdapter.ts` producing a
   `ReplayLog` with `source: "<platform>"`.
2. Wire `getReplayLog` on the corresponding
   `app/services/connectors/<Platform>LeagueConnector.server.ts`.
3. Add a column to the matrix above and fill in every feature row.
4. Extend the `ReplaySource` union in [`types.ts`](./types.ts)
   and the `source` enum on
   [`app/db/models/ReplayLog.ts`](../../db/models/ReplayLog.ts).
5. Map the portal `Game.platform` value to the new source in
   `platformToReplaySource` in
   [`app/components/ReplayLink.tsx`](../../components/ReplayLink.tsx)
   and in `pickReplaySource` in
   [`app/services/GameHydrationService.server.ts`](../../services/GameHydrationService.server.ts).

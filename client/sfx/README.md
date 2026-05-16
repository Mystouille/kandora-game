# Game sound effects

Sound assets consumed by `app/game/client/sound.ts`, co-located with
that module so Vite fingerprints them (`/assets/<base>-<hash>.wav`)
and the browser can cache them `immutable` forever. Drop a file in
and `import.meta.glob` picks it up on the next build.

| Cue file (basename) | Triggered by                                       |
| ------------------- | -------------------------------------------------- |
| `draw`              | Any seat draws a tile.                             |
| `discard`           | Any seat discards (non-riichi).                    |
| `riichi_m` / `_f`   | Any seat declares riichi.                          |
| `pon_m` / `_f`      | Any seat calls pon.                                |
| `chi_m` / `_f`      | Any seat calls chi.                                |
| `kan_m` / `_f`      | Any seat calls a kan (open / closed / shouminkan). |
| `ron_m` / `_f`      | A seat wins by ron.                                |
| `tsumo_m` / `_f`    | A seat wins by tsumo.                              |
| `hand_start`        | New hand begins.                                   |
| `match_start`       | Match begins.                                      |

Only `.wav` is shipped (small files, universally decoded). Multi-
variant cues (`_m` / `_f`) are wired via array entries in
`SOUND_FILES` and `pickVariant` picks one at random per play.

Recommended properties: mono, ≤ 200 ms, peak around −3 dBFS, no
silence padding.

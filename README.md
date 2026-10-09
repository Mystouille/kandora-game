# Kandora Game

This subtree hosts the **in-app Kandora mahjong game**: the lobby, the
table UI, the replay viewer, the WS protocol shared with `game-server/`,
and the rules engine.

The portal and the standalone Capacitor shell both consume this source today;
it remains **designed to be extracted** into its own repo. Read
[docs/mahjong-game-plan.md](../../docs/mahjong-game-plan.md) for the master
plan; this README captures the boundary contract.

## Feature gate

The game is **off by default in every environment** — local, staging,
production. Opt in by setting:

```
GAME_ENABLED=true
```

The gate has two enforcement points:

1. **Server-side (source of truth).** Every game route loader calls
   [`requireGameEnabled()`](./feature-gate.ts), which throws a `404`
   response when the flag is off. The WS upgrade handler in
   `game-server/` does the same.
2. **Client-side (UX only).** The portal navigation reads the sanitized
   `getClientGameFlag()` and hides game entry points when disabled. Never
   trust the client flag for access control.

`GAME_ENABLED` is the only env var the game subtree reads from the
portal config. Anything else must go through the `PortalAdapter`.

## Extraction contract

Game code in `app/game/**` and `game-server/**` must follow these rules:

- **No imports from portal feature code.** Allowed portal imports are:
  - `~/core/models/game/**` — shared Mongoose schemas (day-one shortcut; see plan).
    The other model ownership directories (`portal`, `shared`, and `tournament`)
    are host-owned and must not be imported from the game subtree. ESLint
    enforces the broader boundary; the `db/models/game/` distinction is enforced in code review
    (the built-in `no-restricted-imports` rule cannot express the
    "allow this subdirectory" exception).
  - `~/game/portal-adapter/**` — the single integration seam.
  - `config` — only via `~/game/feature-gate` (the `config` import is
    blocked everywhere else in the game subtree).
- **Host concerns use explicit ports.** Auth verification, user profile
  lookups, and optional match-end notifications go through `PortalAdapter`.
  Authoritative session persistence goes through `MatchRepository`, while
  authority/calendar time, scheduling, and randomness go through `MatchRuntime`. The Node
  composition root injects Mongo and system-runtime implementations; portable
  hosts can inject SQLite and lifecycle-aware implementations without changing
  match behavior.
- **No UI imports from portal components.** Game UI lives entirely under
  `app/game/components/` and may reuse the shared design tokens
  (Tailwind config, CSS variables) but not concrete portal components.

The ESLint `no-restricted-imports` rule scoped to `app/game/**` and
`game-server/**` enforces these boundaries with severity `error`. Do not
weaken the rule to land a feature — refactor through the adapter instead.

## Game setup

Web, mobile online, and local/Nearby lobbies start at **Riichi / Yonma
(4 players) / M-League**. Choose **Riichi** or **MCR** first. Riichi then offers
**Yonma (4 players)** or **Sanma (3 players)**, followed by the applicable game
types: the lobby's Riichi presets for Yonma, or **Online / Kansai** for Sanma.
MCR uses the fixed four-player EMA Green Book profile without Riichi selectors.
**Duplicate** has its own section and seed field, independent of these choices.
Resuming a saved table keeps that table's rules rather than using new-game defaults.

### Debug seed (engine testing)

The web lobby's **Debug seed** menu supports every Riichi preset, including
Buu, both sanma variants, and MCR:

- **Starting hand:** 13 tiles before the opening draw. MCR still starts with
  14 tiles: the first queued draw overrides the dealer's opening tile, or
  that tile remains random when the draw queue is empty.
- **Next draws:** consumed in order for ordinary draws and flower, nuki, and
  kan replacements. Opening Kansai nuki replacements precede the first
  ordinary draw. MCR opening flowers are banked and replaced automatically.
- **Bot discards:** target the previous active bot, seat 3 in four-player
  games or seat 2 in sanma.

Compact notation supports `m`, `p`, `s`, `z`, and MCR flowers `1f` through
`8f`. For example, `123456789p1234s` is a valid thirteen-tile input in every
game type. Tiles absent from the selected rules are rejected with an error;
flowers and mandatory Kansai nuki tiles cannot be forced discards. Physical
copy counts are intentionally unrestricted for engine testing.

Debug overrides remain unavailable in **Duplicate** mode so that its public
seed continues to determine the deal and personal draw queues.

## Three-player mahjong (sanma)

Choose **Riichi / Sanma (3 players)** in game setup to select **Online** or
**Kansai**. Sanma uses a fixed M-League-derived
profile, without head-bump ron, with three hands per wind and no chii.
Both variants support Duplicate, native web/mobile play, local/Nearby hosting,
spectating, recovery, and native replay/review.

[Sanma rules and implementation](./docs/sanma.md) documents the exact payment
table, nuki behavior, wall policies, and the fixed empty position to initial
East's left. The standard wall policies do not apply to Duplicate's personal
draw queues. Buu combinations, tournament standings, and new external-platform
sanma integrations are not supported.

## Shared rules and match scoring

The JSON [presets](./rules/presets/) own gameplay and match-settlement rules.
Platform adapters and tournament standings consume these same definitions;
tournament formats only determine phase structure and aggregation.

Alongside `startingScore`, [RuleSet](./rules/ruleSet.ts) defines:

- `returnScore`: deducted from each final table score. Four times its
  difference from `startingScore` is the first-place oka.
- `uma`: five zero-sum rows of four placement bonuses, in thousands of points.
  Rows count players **strictly below** `returnScore` (0 through 4); columns
  are first through fourth place.
- `roundFinalScores`: round settled match points to integers, halfway away
  from zero; otherwise retain one decimal.
- `splitTiedUma`: share the relevant placement bonuses and oka between tied
  players. When false, seat order breaks ties.
- `minimumScoreToWin`: `null` preserves the fixed-length match behavior.
  A value enables an extra wind if nobody reaches that score at the normal
  end. During extension, reaching the threshold ends the match, including
  on an exhaustive draw. The extension is capped at one wind (never beyond
  North); ordinary dealer continuation still applies at its last hand.
  This is distinct from Buu's immediate `winnerThreshold`.

[calculateMatchPoints](./rules/matchScoring.ts) returns seat-ordered four-player match
points without mutating raw table scores. Existing native result displays and
replay `finalScore` fields continue to represent raw points.
Sanma native results likewise use raw scores; the four-column tournament UMA
calculator explicitly rejects sanma rather than inventing a fourth placement.

EMA uses 30,000/30,000 and +15/+5/-5/-15. M-League uses 25,000/30,000
and +30/+10/-10/-30, plus the resulting 20-point oka. JPML A uses
30,000/30,000 and floating UMA; its starting score is intentionally raised
from the previous 25,000. Nagashi mangan and the four-winds, four-riichi,
and nine-terminals abortive draws are disabled for JPML A. Built-in
presets keep the previous fixed-length behavior (`minimumScoreToWin: null`).

Legacy serialized rules lacking settlement fields remain readable: no
extension, return score equal to starting score, zero UMA, no rounding and
seat-order ties. New presets must specify every settlement field explicitly.
Use the host's tests with selectors `matchScoring.spec.ts`, `matchEnd.spec.ts`,
`ruleSet.spec.ts` and `presets.spec.ts` to validate changes.

## Browser control sizing

Live play, live spectating, and the host's replay/review screen use
[one viewport sizing hook](./client/webTableUiScale.ts) and
[scoped UI styles](./client/webTableUi.css). They measure the available game
container and apply `clamp(0.75, min(width / 1280, height / 900), 1)` to the
surrounding controls. Large windows retain normal sizes; smaller windows stop
shrinking at 75%. Labels and player names remain at least 12px and secondary
details at least 10px with the default browser font size.

The `web-table-ui` scope adjusts Tailwind spacing/type tokens and explicit
panel dimensions, not the canvas or drawing coordinates. It includes the
viewer list, side menus, navigation, settings, and replay review controls.
The top-left debug/metadata bars are not displayed.
Viewer lists retain manual collapse and scrolling;
resizing never changes menu state or selects compact-table mode automatically.
At the minimum size, very small windows may still have overlapping open panels.
Shared components outside this scope, including native mobile consumers, keep
their existing sizes.

Spectate and replay settings include **Show controls**, enabled by default.
Turning it off hides the right-side seat/round selectors, navigation, and event
counter without stopping live updates or changing the selected seat/playhead.
Settings, quit/share, the left menu, and viewers remain accessible. The toggle
is local to the current viewer page and is not offered during live play.

The host's `npm test -- webTableUiScale.spec.ts` checks the scale policy.
`npm run test:e2e -- responsive.e2e.ts drawing.e2e.ts` measures the actual
browser controls, exercises resizing/editing/navigation, and checks drawing
alignment at DPR 1 and 2 using isolated fixtures without external services.

## Platform adapters

- [Tenhou live spectating](./adapters/tenhou/README.md) describes the upstream
  spectator protocol, stateful decoder, relay lifecycle, delayed startup,
  tournament integration, fixture tests, and current limitations.

## Live turn pacing

The server pauses 500 ms before each draw and keeps the 700 ms automated
draw-to-discard pause for bots, riichi, and disconnected seats. Live
presentation uses a 250 ms discard slide followed by a 450 ms hover.
The next draw then starts alongside the 150 ms discard settle, rather
than waiting for settling to finish.

The 500 ms minimum visual draw-to-discard interval keeps automated turns
on a 1.2-second cadence without skipping draw animations or landing sounds.
Manual replay/history navigation retains its immediate timing.

## Authoritative timing

All cloud, local, and Nearby matches use explicit decision windows. Online and
Nearby clients negotiate support automatically; an incompatible player is
rejected explicitly.

Turn/call/declaration and fixed ready/continue-vote windows use one authority
reference, stable identities, clock probes, frozen bounded latency allowance
and input receipts captured before host queues. Only bank-eligible decisions
charge the bank, in exact milliseconds. A normal draw's clock opens at its
canonical landed/readable point.
Late presentation uses the authoritative schedule instead of restarting a
full animation at packet arrival. Checkpoint version 8 preserves fixed prompts,
calendar timestamps, exact balances, remaining phase durations, and pending
sanma replacements. Recovery
uses one captured reference across owners and never revives a resolved or
cancelled decision. Readers for versions 1-7 and legacy pending commands remain;
older saves are migrated to authoritative windows when loaded.

The match and renderer facades stay within their 800-line budgets; extracted
concerns stay within 500 lines. Mutable
state stays in typed domain owners rather than a copied facade context.
Web/native ready and vote controls use the shared synchronized countdown.
Foreground clock refresh, resync and ownership transfer do not issue a fresh
budget. Players must negotiate both `clock-window-v2` and
`fixedPromptVersion: 1`;
older turn-only clients get an explicit update error.

`GAME_TIMING_DIAGNOSTICS=true` adds structured local timing
records correlated by match, epoch, window, seat and connection generation.
Server/client histories are bounded and omit private tile/action contents.
Client observations never authorize or replenish time.

Current-code native lifecycle/radio/storage, iOS and isolated Mongo durability remain release
gates. The 30 FPS Playwright profile is deferred at the user's request; it is
not counted as passing fairness evidence and the 100 ms tolerance is unchanged.
This activation is not a claim that every competitive fairness gate has passed.
Raw private-information delivery is unchanged.

Checkpoint migration preserves an outstanding window's remaining values without
granting a fresh budget. Keep version-7-compatible readers when rolling back
unrelated releases.

## Spectator delay

Game creators choose **Instant** (the default) or **5 min** in the web lobby
or the bottom-left selector of the mobile create-game modal. Room creation
accepts `spectatorDelayMs` as `0` or `300000`; omitted settings preserve
instant spectating for existing clients and checkpoints.

The game server enforces this minimum for every spectator, including users
redirected from a full running table. A viewer may request a longer delay,
but cannot shorten the creator's setting. Delayed connections receive no
current-state snapshot, and both event delivery and resync obey the delay.
The initial `spectator_config` frame reports the effective delay without
revealing game state, allowing web and mobile to explain the waiting period.
The setting is stored in checkpoints and match documents, and game-link
Open Graph/Discord descriptions reflect it.

Tenhou relays retain their existing upstream five-minute delay and do not
add another server-side delay.

## Replay review drawings

New freehand strokes follow the **focused player's discard tiles**, using the
renderer's actual pond origin and uniform tile scale. Web, compact web, and
mobile therefore keep a circle or cross on the same focused-player discard.
The drawing surface still covers the table: overlapping hands or other ponds
is allowed, but alignment with those other elements is not guaranteed.
Changing the review perspective retains the existing drawing-hiding policy.

The [drawing codec](replay/reviewDrawing.ts) writes anchored strokes as v3:
signed float32 coordinate pairs in unscaled focused-discard space. A per-stroke
tag preserves legacy table-normalized strokes when both kinds are edited
together. Legacy-only drawings retain their v1/v2 reading and v2 writing
behavior; no existing records are migrated or repaired. The blob/base64 API
contract and 64 KiB limit are unchanged. Unsupported or malformed new drawings
produce an explicit error rather than being silently discarded.

Both web layouts support authoring; mobile remains read-only and needs a
version containing the v3 reader to display new drawings. Tile stickers are
not part of this feature.

Geometry/codec regressions are covered by the focused Vitest specs. The host's
`npm run test:e2e -- drawing.e2e.ts` exercises the actual Pixi renderer and
overlay at DPR 1 and 2, including layout changes, resize, save/reload, draft
recovery, cancellation, and reviewer colors.

## Layout (planned)

```
app/game/
  feature-gate.ts              ← server gate + client flag exporter
  portal-adapter/              ← the only seam to portal internals
    index.ts                   ← `import { adapter } from "~/game/portal-adapter"`
    types.ts                   ← `PortalAdapter` interface
    portal.ts                  ← current portal-hosted implementation
    standalone.ts              ← stub for the future standalone build
  protocol/                    ← WS message types, shared with game-server
  rules/                       ← pure rules engine (no I/O)
  server/src/
    match.ts                   ← portable authoritative session
    checkpoint.ts              ← versioned checkpoint validation
    repository.ts              ← persistence contract + explicit ephemeral impl
    runtime.ts                 ← clock / scheduling / randomness contract
    persist.ts                 ← Node/Mongo repository implementation
  components/                  ← table UI, replay viewer, lobby
  routes/                      ← portal-side React Router entries
  README.md                    ← this file
```

`game-server/` is a sibling top-level directory: the standalone Node
process that runs match sessions. It speaks the same `protocol/` and
consumes the same `PortalAdapter`.

## Mobile host

The source under [`mobile/`](../../mobile/) is a standalone React/Vite entry,
not a route inside the server-rendered portal. Its `~` alias resolves directly
to `app/`, so the production Pixi renderer, event protocol, replay reducer,
checkpoint schemas, and repository contract compile from this subtree without
copies. Vite writes a self-contained offline document to `build/mobile`, and
[Capacitor](../../capacitor.config.ts) copies it into the generated `android/`
and `ios/` projects.

```sh
npm run mobile:dev
npm run mobile:typecheck
npm run mobile:build
npm run mobile:sync
```

The current shell renders the real table, validates/imports shared `ReplayLog`
JSON, and initializes native SQLite persistence. SQLite stores best-effort live
event journals, explicit-pause checkpoints, terminal tombstones, completed
matches, and replay archives; browser development injects the in-memory
implementation.
The mobile loopback controller hosts one human plus three bots in-process and
dispatches `ServerMessage` objects through the same client-store function as
`GameWS`. Native background/foreground and manual Pause/Resume replace the
frozen process from SQLite rather than mutating it after save. Android debug
compilation is verified with Java 21/API 36. The iOS project is generated and
synchronized, but compilation/signing requires macOS and Xcode. Cloud and
multi-phone Nearby host/join remain pending transport adapters.

Hosted player sockets use a session-scoped opaque client ID in addition to the
authenticated user ID. A normal reconnect may reclaim only the same client
session. A different web/mobile session must send an explicit one-shot takeover;
the server installs it first, retires the previous socket with
`session_replaced`, and sends the destination an authoritative private
snapshot. Client IDs are transport-fencing metadata, not credentials. Only
playing matches participate in this handoff: disconnecting from a waiting room
releases the seat immediately.

## Checkpoints

`MatchProcess.createCheckpoint()` and `MatchProcess.restoreCheckpoint()`
support `waiting` rooms and five quiescent in-progress boundaries: a human
discard/action window (including the fixed five-second Tenpai/Noten declaration
window); one or more call decisions after a discard/shouminkan; an
initial/post-hand ready check; a staged post-hand result reveal; or a Buu
continue vote after a completed game. The versioned schema stores exact rules,
occupants, private engine state, event/sequence state, PRNG state, session
ledgers, captured human/bot call intents, result/ready/vote continuations, final
standings needed for Buu reseating, per-seat disconnect/explicit-AFK/liveness-
strike policy, and every remaining deadline duration. Wall-clock timestamps are
restored relative to the new runtime so suspended time consumes no clock.

## Exhaustive-draw declarations

When tenpai status can affect the active rules, native matches collect public
Tenpai/Noten declarations in current East-to-North order before settling an
exhaustive draw. Actual-noten seats, riichi seats, and bots are resolved
automatically; eligible humans receive a short legal-action window. Live and
delayed-spectator streams retain one event per declaration for sequencing and
resync. Native `ReplayLog` persistence compacts those transient events into the
following exhaustive-draw `hand_end`, so stored replay playback opens the final
result immediately. Platform-imported and older replay logs remain valid
without declaration metadata.

Sockets, liveness probe callbacks, and in-flight probes are process-local and
are never serialized; restored players reconnect through the normal
claim/attach flow. A network-only disconnect clears on a fresh attachment,
whereas explicit AFK survives reattachment until `afk:false`. An in-flight
liveness probe may be checkpointed; the old callback re-checks pause/connection
generation before mutating and restored processes start with no probe. A
disconnected/AFK action or call owner is stored with the remaining short
auto-default deadline and resumes that safe discard/pass after restoration.
Checkpoint creation still fails while the automatic action itself is mutating.
Remaining pacing sleeps (win reaction, turn/draw-to-discard pacing, match-end
display, win-to-panel), the internal win→chombo display pause, relays, and
delayed spectators remain explicitly uncheckpointable.

During normal play, accepted commands mutate the in-memory authority without
awaiting Mongo or SQLite. Archive-enriched `GameEvent` records enter an ordered
per-game journal queue after they enter the authoritative event log. The queue
batches contiguous sequences, retries transient failures, and never applies
storage backpressure to a turn. A cloud process crash still loses its active
match; partial journal prefixes are diagnostic data, not resumable authority.

`pauseAndSaveCheckpoint()` is the deliberate durability boundary. It freezes
mutation, cancels active phase timers, flushes the event journal, and then saves
one full checkpoint. Concurrent pause calls share the operation. Success leaves
the old process frozen for disposal; a failed flush or checkpoint write rebases
saved durations onto the current runtime and resumes the same process without
charging the I/O interval. Mobile exact resume is promised only after this
barrier completes. Native OS background callbacks invoke it best-effort, but an
OS may suspend JavaScript before the write finishes.

At game end, final archival seals the journal, waits only for an already-started
batch, and replaces the partial prefix with the complete in-memory log. This
archive remains awaited before Buu continuation or session completion. Restored
checkpoints are consumed when their host becomes active so a later abrupt kill
cannot silently roll visible play back to an old checkpoint.

Recovery rows containing `pendingCommand` from older builds remain supported.
The command is validated against its saved input window, replayed once, and the
row is replaced with one clean checkpoint. New gameplay never creates pending
command rows.

Before emitting terminal `session_end`, `MatchProcess` atomically replaces any
existing checkpoint with a retained terminal tombstone. Loads then return no
resumable match and stale writers cannot overwrite the marker. A failed marker
write leaves finalization pending, emits no `session_end`, and can be retried via
`retryPendingFinalization()`. Sessions that never saved a checkpoint do not
create tombstone rows. `deleteSavedCheckpoint()` is an explicit administrative
purge, not normal completion cleanup. The Node adapter stores records in
`game_match_checkpoints`; mobile will provide the corresponding SQLite adapter.

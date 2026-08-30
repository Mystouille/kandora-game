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
  wall time, scheduling, and randomness go through `MatchRuntime`. The Node
  composition root injects Mongo and system-runtime implementations; portable
  hosts can inject SQLite and lifecycle-aware implementations without changing
  match behavior.
- **No UI imports from portal components.** Game UI lives entirely under
  `app/game/components/` and may reuse the shared design tokens
  (Tailwind config, CSS variables) but not concrete portal components.

The ESLint `no-restricted-imports` rule scoped to `app/game/**` and
`game-server/**` enforces these boundaries with severity `error`. Do not
weaken the rule to land a feature — refactor through the adapter instead.

## Platform adapters

- [Tenhou live spectating](./adapters/tenhou/README.md) describes the upstream
  spectator protocol, stateful decoder, relay lifecycle, delayed startup,
  tournament integration, fixture tests, and current limitations.

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

## Checkpoints

`MatchProcess.createCheckpoint()` and `MatchProcess.restoreCheckpoint()`
support `waiting` rooms and five quiescent in-progress boundaries: a human
discard/action window; one or more call decisions after a discard/shouminkan;
an initial/post-hand ready check; a staged post-hand result reveal; or a Buu
continue vote after a completed game. The versioned schema stores exact rules,
occupants, private engine state, event/sequence state, PRNG state, session
ledgers, captured human/bot call intents, result/ready/vote continuations, final
standings needed for Buu reseating, per-seat disconnect/explicit-AFK/liveness-
strike policy, and every remaining deadline duration. Wall-clock timestamps are
restored relative to the new runtime so suspended time consumes no clock.

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

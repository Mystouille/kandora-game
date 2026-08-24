# Kandora Game (in-portal)

This subtree hosts the **in-app Kandora mahjong game**: the lobby, the
table UI, the replay viewer, the WS protocol shared with `game-server/`,
and the rules engine.

It ships inside the portal today but is **designed to be extracted** into
its own repo. Read [docs/mahjong-game-plan.md](../../docs/mahjong-game-plan.md)
for the master plan; this README captures the boundary contract.

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

`pauseAndSaveCheckpoint()` freezes mutation and cancels every active phase timer
before awaiting `MatchRepository.saveCheckpoint()`. Concurrent pause calls share
one write. Success leaves the old process frozen for disposal; a failed atomic
write rebases the saved durations onto the current runtime and resumes the same
process without charging the I/O interval. `restoreSavedCheckpoint()` loads and
validates through the repository.

Accepted `act`, `ready`, `vote_continue`, and self-reported `afk` frames use a
write-ahead recovery record. Before authority mutates, `MatchProcess` freezes
the current input window and atomically stores its checkpoint together with the
seat and command payload. An `afk:true` record also carries the exact safe
default selected from that window (`pass` or tsumogiri/fallback discard), so the
sticky flag and default are one crash-safe command. Recovery validates every
command against its exact action/ready/vote window, restores the pre-state,
replays once, and replaces the pending record with the resulting checkpoint.

The final ready acknowledgment and a resolving Buu vote commit a completed
window checkpoint before starting their asynchronous continuation. Installing
that checkpoint, either after the commit or during recovery, consumes the
continuation: deal/start the hand, begin the next Buu game, or finalize the
session. This makes a crash on either side of the continuation deterministic.
Likewise, a gameplay command that reaches a staged result reveal, ready check,
or Buu vote commits that open boundary and releases command ownership before
waiting. Recovery therefore returns a usable match at the boundary instead of
blocking on input that can only arrive after reconnection. Frames arriving
while the boundary write is in flight wait for that write, not for the parent
command whose continuation depends on those frames.

A failed write-ahead save mutates nothing and resumes the original timers. A
failed post-command commit leaves the advanced process paused and the durable
pre-state/command intact; `retryPendingCommandCommit()` commits that captured
post-state before input resumes. Terminalization replaces either form with the
same tombstone. A detached replay continuation that fails after recovery has
returned also pauses the process and exposes its cause through
`pendingCommandRecoveryError`. Transactional gameplay covers discard,
call/pass, kan, win, riichi, and explicit AFK opt-out/opt-in. `start_match`,
`leave_seat`, raw network detach, and ordinary server deadline/liveness defaults
do not write their own command record yet. Automatic defaults serialize against
client input and are replayable from the latest disconnected-window checkpoint,
but only a later command or explicit lifecycle save advances durable storage.

Before emitting terminal `session_end`, `MatchProcess` atomically replaces any
existing checkpoint with a retained terminal tombstone. Loads then return no
resumable match and stale writers cannot overwrite the marker. A failed marker
write leaves finalization pending, emits no `session_end`, and can be retried via
`retryPendingFinalization()`. Sessions that never saved a checkpoint do not
create tombstone rows. `deleteSavedCheckpoint()` is an explicit administrative
purge, not normal completion cleanup. The Node adapter stores records in
`game_match_checkpoints`; mobile will provide the corresponding SQLite adapter.

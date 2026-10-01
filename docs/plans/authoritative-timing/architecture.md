# Architecture brief: timing and game modularization

Read this with [plan.md](plan.md) for tasks/target ownership and [spec.md](spec.md) for requirements and acceptance criteria. No separate YAML or checkpoint documents are needed.

Evidence: static inspection of the active game submodule and tournament native hosts on 2026-10-01, including the existing uncommitted spectator/pacing work. This is a scoped planning baseline, not a whole-portal inventory or runtime sign-off.

## Ownership and runtime paths

The game is the `Mystouille/kandora-game` submodule at `kandora-tournaments/app/game`. Cloud composition and shared game/presentation code live here; native controllers, SQLite and Nearby integration belong to the parent tournament checkout.

| Runtime surface | Entry and shared dependencies                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud session   | [WebSocket composition](../../../server/src/index.ts) authenticates/fences the owner and routes validated player/spectator messages to [MatchProcess](../../../server/src/match.ts)                                                                                                      |
| Web player      | [Player page](../../../routes/match.tsx) connects [GameWS](../../../client/ws.ts), the [shared store](../../../client/store.ts), [TableRenderer](../../../client/pixi/TableRenderer.ts), inputs and sounds                                                                               |
| Web spectator   | [Spectator page](../../../routes/spectate.tsx) maintains a read-only baseline/history and uses the same transport/renderer without player decision authority                                                                                                                             |
| Native shell    | [App](../../../../../mobile/src/App.tsx) binds the renderer to [online](../../../../../mobile/src/online/OnlineMatchController.ts), [local](../../../../../mobile/src/local/LocalMatchController.ts) and [Nearby](../../../../../mobile/src/nearby/NearbyMatchController.ts) controllers |

Cloud and native local/Nearby hosts share the authoritative process through [MatchRuntime](../../../server/src/runtime.ts) and [MatchRepository](../../../server/src/repository.ts). Web/native views share message validation, store projection, renderer lifecycle and semantic callbacks. Do not fork those owners during extraction.

## Existing stack and size baseline

[Host package.json](../../../../../package.json) records Node >=22, TypeScript ^5.9.2, React ^19.2.3, React Router 7.10.1, Pixi ^8.18.1, Howler ^2.2.4, Zustand ^5.0.13, Zod ^4.4.3, `ws` ^8.20.0, Mongoose ^9.0.1 and Capacitor/SQLite. These are manifest ranges, not newly verified resolved versions. Keep this stack.

Recorded line counts from the original scoped inspection:

| File                                                   | Lines |
| ------------------------------------------------------ | ----: |
| [MatchProcess](../../../server/src/match.ts)           |  7484 |
| [TableRenderer](../../../client/pixi/TableRenderer.ts) |  8558 |
| [GameWS](../../../client/ws.ts)                        |   591 |
| [Native App](../../../../../mobile/src/App.tsx)        |  2545 |

These sizes justify looking for concerns, not splitting arbitrary line ranges. The plan's target owners and module-size goals are separate from these observations.

## Current timing and state

- `MatchRuntime.now()` uses `Date.now()`; the port also owns cancellable scheduling, sleep and PRNG capture/restore.
- [MatchProcess](../../../server/src/match.ts) owns four-seat roster/state/driver, command/default arbitration, turn/call workflows, hand/session continuations, events, recovery and timing.
- Legal windows currently use parallel per-seat arrays for actions, base deadline, timer, expiry epoch, start time and kind. Several call windows can be open concurrently.
- The base budget is 5000 ms and the per-hand bank 20000 ms. Legacy expiry adds 200 ms grace. Current bank charging floors the remaining balance to whole seconds after overage; precise charging is an intentional later change.
- [Gameplay messages](../../../protocol/messages.ts) carry sequence, state/events, legal actions and optional `deadline`/`bufferMs`. `deadline` is the end of the base budget, not the full bank-plus-transport expiry. Current `act` has `matchId`/`actionId`, not a public window identity.
- [Message dispatch](../../../client/dispatchServerMessage.ts) projects server values into the shared store; [TableRenderer](../../../client/pixi/TableRenderer.ts) ticks the countdown against the device wall clock.
- Socket heartbeat records liveness/last pong and sends application keepalive. Browser JavaScript cannot observe WebSocket protocol pongs. The inspected paths do not yet have a reusable offset estimator or authority-owned RTT profile.
- [DiscardAnimator](../../../client/pixi/discardAnimator.ts) serializes slide/hover and the next draw while settling overlaps. Keep its minimum display time, catch-up protection, once-only cues and fast-confirmed-discard draw-landing fix.

The bank/window/runtime must each retain one authority. Client state and renderer state are projections, not another bank or legality owner.

## Refactor boundaries

Match concerns already have recognizable source boundaries: kernel/driver mutation; room/connection ownership; command/default coordination; turn and call resolution; hand/Buu lifecycle; event/projection/journal/archive publication; and checkpoint capture/restore.

Renderer concerns include pure geometry/metrics, Pixi scene/assets/lifecycle, perspective-specific hands/draw overlays, ponds/melds/walls, result staging, scores/names/round/debug HUD, timer projection, and pointer/control interaction.

Preserve public facades, options, setters/callbacks and exported helper imports while moving implementations. Pass narrow typed ports or small readonly render resources; do not replace either large file with a mutable context containing all former private fields.

The [plan](plan.md#target-ownership-and-readable-logic) chooses the actual owners and extraction order. Rules, presets, duplicate generation, projection/redaction semantics, archive/replay meaning and external decoder logic remain outside behavioral redesign. Current raw private-information delivery is unchanged; no reveal phase is introduced.

## Behaviors that must survive extraction

### Cloud authority and web player

- Preserve the server feature gate, authenticated seat/session ownership, explicit takeover, waiting-room/host behavior, hello timeout, heartbeat/liveness and terminal-error handling.
- Preserve per-match command/default serialization, sequence/epoch guards and pause/journal barriers. Do not replay a stale command after state advances.
- On player resync, send a fresh private snapshot; do not replay draw/discard events over an already-restored baseline.
- Check for a human before and after bot pacing, so a replaced bot cannot discard for its new human occupant.
- Keep independent call windows and resolve Mahjong priority over the collected responses, not first arrival.
- Preserve schema-validation errors, explicit durable failures, asynchronous journals and archive ordering.
- Preserve page/store reset, renderer mount/destroy, semantic input callbacks and retimed sound bindings. Keep GameWS observer-before-default-store ordering when inserting clock updates.
- Keep terminal room/ownership errors out of automatic reconnect loops.

### Native hosts

- [Local input](../../../../../mobile/src/local/LocalMatchController.ts) enters an operation queue before match command processing; capture the planned receipt before either queue.
- [Nearby input](../../../../../mobile/src/nearby/NearbyMatchController.ts) validates/routes the frame before its host queue. Its ready-ack bypass releases a waiting operation and must not be moved behind that same queue.
- Only the local process or Nearby host is authority. Online native uses the shared GameWS; guests and the UI remain projections.
- Preserve local manual/background pause and durable process replacement on resume. Cloud reconnect/transfer restores the outstanding decision rather than receiving a new base budget.
- Keep SQLite and browser memory adapters behind the same persistence contract. Real OS suspension/storage/radio behavior still needs native evidence; a browser fixture is not a substitute.
- Preserve the [Nearby envelope](../../../../../mobile/src/nearby/protocol.ts): version 1, hello/client/server kind, common inner message and 32 KiB limit. Outer-envelope and inner timing-capability evolution are distinct.

### Spectators and history

- Preserve the read-only baseline plus append-only history and unseen-sequence handling; overlapping resync must not duplicate events.
- Following live uses sequencing/retimed cues; manual history disables live minimum/pacing constraints.
- Spectators have no legal actions or thinking bank. Timing metadata must not release an unripe event or future private state.
- Distinguish actual native dispatch delay from informational upstream relay delay. Already-delayed external relay data must not get another five-minute presentation offset.

## Compatibility mappings

Keep existing hello/act/ready/resync discriminants, authentication, owner fencing and error behavior while introducing additive negotiated clock/window/presentation metadata in shadow mode.

| Existing value/contract       | Mapping or preservation rule                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `deadline`                    | Derived compatibility view of the owning window's base-budget end; do not treat it as full expiry                              |
| `bufferMs`                    | Derived view of exact authoritative bank; legacy mode keeps legacy accounting until activation                                 |
| `actionId`                    | Retain action meaning while adding window/session/generation identity to fence delayed inputs                                  |
| Snapshot replay/retry         | Refer to the same window and known remaining budget; never replenish time                                                      |
| Fixed declarations            | Retain no-bank eligibility and existing defaults                                                                               |
| Inactive window               | Clear actions and deadline together                                                                                            |
| Legacy versus upgraded player | Shadow can keep an entire match legacy; new-mode activation requires all player capabilities and a pinned match timing version |
| Incompatible new-mode client  | Explicit update requirement, not silent fallback or a permanent reconnect loop                                                 |
| Renderer API                  | Retain mount/render/destroy, options, setters, semantic callbacks and helper re-exports; no game authority moves into Pixi     |

Timer-start, exact millisecond charging and adaptive allowance are intentional changes. Their tests must be separate from extraction-only fidelity.

## Recovery mapping and atomicity

[Checkpoint version 4](../../../server/src/checkpoint.ts) stores state/driver/PRNG, roster, bank, sequences, connection policy, relative event/start ages and continuation timing. Action continuations hold kind/seat/actions plus elapsed, visible remaining and expiry remaining; call/readiness/vote/result continuations have their own fields.

[The repository port](../../../server/src/repository.ts) atomically replaces checkpoints, reads legacy pending-command recovery, marks terminal tombstones and archives matches/replays. Mongo and [native SQLite/memory](../../../../../mobile/src/persistence/mobileMatchRepository.ts) implement that port. Native database version 2 is not the game checkpoint version.

When adding explicit-window recovery:

- Preserve repository signatures and tombstone/durable-error semantics; changing payload representation does not justify a storage rewrite.
- Capture engine, owner modules, windows, bank, sequences and continuations consistently after command/journal barriers.
- Migrate known elapsed/remaining values and bank exactly. Do not infer fractions already lost by legacy whole-second rounding.
- Persist window identity, timing mode and frozen allowance; restore into the new clock epoch by rebasing remaining durations once.
- Restore/retry must neither charge twice nor issue a new base budget/allowance. An expired or terminal decision cannot be revived.
- Retain readers for old versions and pending commands. Handle zero remaining time, concurrent calls and every ready/vote/result continuation explicitly.
- Invalid/inconsistent recovery is an error, not permission to start a fresh game or use ephemeral success.

## What implementation must verify

Use the [plan's fairness matrix](plan.md#testing-strategy) to measure usable decision intervals, not only animation duration equality. Clock skew, foreground/resume, ingress/default races, ownership transfer and delayed/external presentation axes require behavioral evidence.

The planning baseline found Node 22.14.0, no Docker command and no project-local Playwright package. Those are recorded prerequisites/gaps, not a reason to silently omit browser/native acceptance. Runtime implementation and sign-off have not been performed by this documentation packet.

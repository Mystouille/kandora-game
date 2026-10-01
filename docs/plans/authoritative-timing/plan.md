# Implementation plan: authoritative timing and readable game modules

Date: 2026-10-01. Status: implementation and software verification complete (41/43 tasks); native/rollout gates and user-deferred 30 FPS browser evidence remain separately tracked.

Requirements and acceptance criteria: [spec.md](spec.md). Current architecture and compatibility/recovery boundaries: [architecture.md](architecture.md).

## Implementation progress

Implemented and verified:

- Domain renderer extraction: the public renderer is 485 lines, with scene/assets/geometry, hand/pond/meld/wall, results, interaction/controls and HUD owners.
- The public match facade is 650 lines, with a 441-line typed composition and cohesive kernel, roster, connection, command, turn/call, hand/session, archive, spectator/relay and recovery owners. Automated gates enforce facade <=800 and new handwritten concern <=500 physical lines.
- Clock/window/presentation DTOs, monotonic authority/client clocks, quality filtering and correlated clock/latency probes.
- Turn/call/declaration and fixed ready/continue-vote windows, readiness at draw landing, bounded frozen allowance, ingress reservations and exact bank accounting.
- Version-7 recovery retains fixed prompts, partial acknowledgements/votes, calendar timestamps and the same remaining budgets. Every owner uses one captured restoration reference; cancelled/resolved decisions cannot debit or resume again. Versions 1-6 and legacy pending commands remain readable.
- Web/native online/local/Nearby integration and historical spectator presentation timing; raw private-information delivery is unchanged.
- Web/native fixed-prompt controls and Buu reconnect snapshots use shared countdown/intent helpers. Foreground clock refresh does not reset a budget; local seats explicitly use zero network delay.
- Queued commands retain receipt/window/connection identity, including equal-millisecond stale-owner cleanup.
- Bounded sanitized authority/client diagnostics and strict additive fixed-prompt capability negotiation.
- Repeatable canonical tests include real Chromium/Pixi/authority journeys.

Final canonical `npm test` passed **312 Vitest files / 2205 tests** and
**30 Chromium journeys**, with **eight explicitly user-deferred 30 FPS skips**.
Web/server and mobile production builds passed. Mobile types and the strict
application-source compiler passed for 1065 inputs, excluding unrelated ignored
utilities; all 102 changed host/game source files passed scoped ESLint with zero
errors/warnings using the TypeScript-aware overload rule. Both worktrees passed
whitespace checks. No commits, remote changes, native installation or production
activation were performed.

The eleven retained normal-frame-rate profiles exercise RTT 0/100/300 ms and
jitter/asymmetry within 50 ms. Fresh recorded measurements passed the unchanged
100 ms limits:

| Measurement                                        |         Observed |       Required |
| -------------------------------------------------- | ---------------: | -------------: |
| Base remaining at first real readable/usable frame |     4970-4997 ms |      >=4900 ms |
| Accepted real Pixi input interval                  | 4991.4-5012.9 ms | 5000 +/-100 ms |
| Countdown/reference error bound                    |          <=76 ms |       <=100 ms |

Higher latency, burst delivery, 15/5 FPS and UI stalls remain explicit degraded
diagnostics, not passing supported-profile evidence. Results use real shared
Pixi controls and WebSocket/MatchProcess authority, not DTO-presence assertions.

Remaining release gates are current-code native storage/lifecycle, two physical
Nearby peers, iOS, isolated Mongo durability and final rollout sign-off. The user explicitly deferred the
30 FPS Playwright profiles after unstable runs: do not keep retrying them,
weaken the <=100 ms threshold, or count normal-frame-rate evidence as 30 FPS
sign-off. The specification's numeric fairness target remains unchanged.

Authoritative windows are the only active timing path. Unchecked tasks below
remain the source of remaining device and fairness evidence; extraction-only or
foundational progress must not be confused with full fairness acceptance.

## Summary

Separate authoritative state, presentation scheduling and decision accounting. Give every live decision one server-owned identity and scheduled ready point, synchronize client clocks, and freeze a bounded latency allowance per window. Preserve current private-information delivery.

Use this change to split the two large implementations by ownership, not arbitrary line ranges:

- [Match process](../../../server/src/match.ts): measured 7484 lines in the inspected baseline.
- [Table renderer](../../../client/pixi/TableRenderer.ts): measured 8558 lines.

Do behavior-preserving extraction first. Then introduce timing metadata and
clock synchronization, followed by accounting/enforcement and required client
capability negotiation. Do not combine mechanical moves and policy changes in
one large diff.

## Technical context

| Area            | Existing context and approach                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | TypeScript/ESM, Node >=22; portable game code is also compiled into the native bundle                                                          |
| Views           | React/React Router, Pixi, Zustand, Howler                                                                                                      |
| Wire            | Validated WebSocket JSON; common inner DTOs also cross the Nearby envelope                                                                     |
| Time            | Injected `MatchRuntime`; currently wall-clock `now`, cancellable timers and sleep                                                              |
| Storage         | Repository port, Mongo archive/recovery, native SQLite/memory                                                                                  |
| Current budgets | 5000 ms base, 20000 ms per-hand bank, 200 ms legacy grace; fixed declarations have separate policy                                             |
| Accepted pacing | 500 ms server pre-draw; 700 ms automated draw-to-discard; 250/450 ms slide/hover; 150 ms concurrent settle; 300 ms draw; 500 ms visual minimum |
| Scope           | Cloud, web player/spectator, native online/local/Nearby, shared recovery and renderer                                                          |
| Target          | Same stack, smaller owned concerns, explicit timing contracts; no rules rewrite or reveal phase                                                |

## Agreed decisions

| Topic                    | Decision                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Refactor scope           | Broad domain-focused breakup of match orchestration and table rendering, not only timing helpers                  |
| Normal discard readiness | Start thinking after the drawn tile lands and controls are fully usable; unrelated settling may continue          |
| Latency allowance        | Adaptive, server-measured, frozen per window; 500 ms total cap and 200 ms fallback when measurements are unusable |
| Private information      | Preserve current raw delivery; no private-information reveal phase                                                |
| Validation               | Dedicated latency/skew/frame-rate/reconnect fairness matrix plus existing behavior-preservation suites            |
| Existing presentation    | Preserve the accepted pacing, overlapping settle, minimum draw display and bot animation/sound fixes              |

The user chose broader extraction over timing-only cleanup, draw landing over first visibility during motion, and adaptive allowance over fixed 200 ms everywhere. These choices and the acceptance targets are retained in [spec.md](spec.md); the file-size targets below are design goals, not measured implementation results.

## Constraints

- Work in the active game submodule; native host integration remains in the parent tournament repository. Inspection clones are not product code.
- Keep shared game code portable through the existing runtime/repository ports and one-way host boundary. This is not a framework migration.
- Preserve rules, presets, duplicate generation, projection/redaction, replay/archive semantics and external decoders; do not rewrite unrelated native shell or portal features.
- Preserve public facades and helper exports during extraction. Use narrow typed boundaries, existing formatting/helpers and explicit errors, not private-state casts or service locators.
- Give each mutable concern one owner; never duplicate bank, timer, roster, legality, sequence or animation authority.
- Separate structural moves from intentional timer-start, precise-charging and allowance changes. Verify each increment before activation.
- Require one clock/window contract for an entire match and reject incompatible player clients explicitly.
- Keep manual replay/external relay timing separate from human windows. A known local zero-network path is not an unusable remote profile.
- Preserve existing spectator/pacing behavior. Implementation does not authorize committing, pushing, deploying or enabling production timing.

See [architecture.md](architecture.md) for the source references, preserved behaviors and concrete compatibility/recovery mappings.

## Target ownership and readable logic

The facade files should read as composition and ordered orchestration. Owners expose typed operations/snapshots, not shared writable bags.

| Concern                          | Sole owner                                    | Narrow boundary                                                           |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Authoritative rules state/driver | `MatchKernel`                                 | Apply validated engine actions; return resulting state/events             |
| Waiting seats/host/readiness     | `RoomRoster`                                  | Seat/host operations and immutable roster view                            |
| Socket owner/fencing/liveness    | `PlayerConnections`                           | Attach/detach/owner checks and connection-quality provider                |
| Live command/default arbitration | `CommandCoordinator`                          | Receipt reservation, ordered execution, pause barrier                     |
| Turn and call workflows          | `TurnCoordinator`, `CallCoordinator`          | Invoke kernel, decisions, pacing and priority resolution                  |
| Hand/results/session lifecycle   | `HandLifecycle`, `SessionCoordinator`         | Ready/vote/result continuations and Buu ledgers                           |
| Decision windows and timers      | `ActionWindowRegistry`                        | Open/reserve/resolve/cancel/capture/restore                               |
| Exact bank                       | `TimeBank`                                    | Grant/debit/snapshot; no renderer or transport mutation                   |
| Authority/latency                | `AuthorityClock`, `LatencyAllowancePolicy`    | Clock epoch/time reference and immutable per-window policy                |
| Recovery                         | `RecoveryCoordinator`                         | Atomic owner capture/restore through existing repository/journal barriers |
| Event/projection/journal/archive | `MatchEventPublisher`                         | Preserve sequence/redaction/archive semantics                             |
| Pixi lifecycle/assets            | `SceneGraph`, `RendererAssets`                | Containers/textures/disposal and readonly render resources                |
| Domain drawing                   | Hands/ponds/melds/walls/results/HUD renderers | Readonly view/layout/assets plus owned domain caches                      |
| Input/hit targets                | `InteractionController`, `ActionControls`     | Semantic callbacks, stable hit targets and readiness gates                |
| Presentation timing              | `PresentationTimeline`                        | Authoritative event schedule, pose/cue reconciliation                     |
| Client clock/window view         | `ServerClock`, `ActionWindowViewModel`        | Shared countdown/readiness projection, no bank authority                  |

Do not create a replacement `MatchContext`/`RendererContext` containing all former private fields. A small readonly `RenderResources`/`RenderFrame` is acceptable; writable state belongs to its owner. Avoid mutual-owner calls: coordinators operate through ports and return effects.

Facade targets: at most 800 lines each. New active handwritten concern modules target at most 500 lines. Split perspective-specific hands/results or geometry helpers when needed; do not satisfy the count by hiding a god context or moving all logic to one new file.

## Timing contract to implement

### Shared reference, not shared device wall time

- An authority clock has a `clockEpoch` and integer millisecond reference derived from a monotonic source, anchored for compatibility with existing epoch-style values.
- Archive/log calendar time remains a separate concern; OS wall-clock adjustments must not charge a bank or move a live deadline.
- Clock probes exchange correlated client monotonic send/receive and authority receive/send stamps. Filter noisy samples; expose uncertainty/quality and refresh after reconnect/foreground.
- RTT is measured by the authority/transport; client timestamps and render acknowledgements are telemetry, never budget authority.

### One explicit decision window

A window contains `id`, match/seat/kind, timing version, `clockEpoch`, legal-action identity, `infoSentAt`, `opensAt`, `baseEndsAt`, `budgetEndsAt`, `expiresAt`, exact bank at open, frozen allowance and generation/state. States are `scheduled`, `open`, `resolved`, `expired` or `cancelled`.

- `opensAt` is the canonical mandatory decision-ready point, not the arrival time of a packet or an animation-complete acknowledgement.
- Normal draw: discard start D, slide ends D+250, hover ends/draw starts D+700, settle ends D+850, draw lands/controls become usable D+1000. The base ends at D+6000.
- Server raw draw delivery remains at the existing logical step; there is no reveal-phase split.
- Call/kan/declaration/readiness/vote policies define their own required UI-ready points and retain bank/default eligibility. Use existing mandatory effect durations; unrelated decoration cannot extend them.
- Reject premature/stale/expired or wrong-session/window commands explicitly. Do not add a premove feature or silently apply an early intent.
- Capture authenticated arrival time before parsing/awaited queues as close to the transport boundary as practical. A timely reserved receipt cannot lose to a later default merely because game processing was queued.
- Revalidate legality/state when executing the reservation. Another resolved transition must still fence the old input.

### Frozen adaptive allowance

For a usable server-measured profile, estimate inbound travel plus any estimated outbound lateness beyond the window's planned information-delivery lead. Include bounded measured jitter/clock uncertainty, then clamp the **total** to [0,500] ms. Use exactly 200 ms when the network profile is unusable. Known direct local input uses its explicit zero-network path rather than pretending a missing network sample is an unknown remote connection.

Suggested conservative estimator: recent robust RTT/2, quality bounds from sample dispersion, and `max(0, estimatedOutboundMs - (opensAt - infoSentAt))`. RTT/2 assumes approximate symmetry; unsupported asymmetry/latency must be diagnosed, not promised perfect fairness.

Freeze the result at open; reconnect and new samples do not replenish it. `expiresAt = budgetEndsAt + frozenAllowanceMs`. Do not also append the old 200 ms as a second hidden grace.

Charge once using authority receipt corrected by that same bounded frozen policy:

```text
effectiveInputAt = max(opensAt, receivedAt - frozenAllowanceMs)
billableOverage = max(0, effectiveInputAt - opensAt - baseBudgetMs)
```

The HUD shows the scheduled game budget, not an advertised extra latency bonus; server reconciliation publishes exact remaining bank. Keep the distinction between visible base end, bank end and transport expiry explicit in names and diagnostics.

### Client presentation and degraded conditions

Progress animations against authoritative stamps; do not start a full local duration whenever a late packet arrives. Reach the required landed/readable/interactive pose at readiness, skipping remaining cosmetic work when late.

Use one window view for countdown, control gating and readiness. Do not extend an authority deadline because a renderer reports it was slow. Reconnect/takeover restores the same window. Foreground invalidates stale clock quality and refreshes it without resetting the game budget.

Delayed native spectators use an explicit actual dispatch/presentation offset; external relay source delay is informational and already applied upstream. Do not subtract the descriptive `spectator_config.delayMs` blindly from every renderer clock.

### Compatibility and intentional behavior changes

- Pin the timing contract version per match and negotiate player capabilities.
- Reject incompatible player clients with an explicit update requirement; do not silently mix clocks.
- Preserve legacy `deadline`/`bufferMs` as derived compatibility fields until callers migrate.
- New precise charging intentionally removes current per-action whole-second flooring.
- New scheduled starts intentionally replace immediate assignment-time billing. These are not disguised as mechanical refactoring.

## Implementation steps and tasks

Task paths are relative to the game repository root. `../../...` denotes the parent tournament host. Each task's `Depends on` lists actual prerequisites; sequence alone is not a dependency. `[P]` means the stated tasks may run independently after their shared prerequisites, not in a same-file worker pool.

### Phase 1 - Baseline and repeatable validation

**1.1 Preserve the accepted baseline and scaffold fairness evidence.** Requirements: REQ-004, REQ-010, REQ-013, REQ-016, REQ-019, REQ-020. Inputs: preserved runtime behaviors in [architecture.md](architecture.md) and the existing test command/discovery.

- [x] T001 [Plan:1.1] Record baseline command/event/recovery/render/sound fixtures in `server/src/session/sessionCompatibility.spec.ts`, `client/pixi/TableRenderer.spec.ts` and `client/pixi/discardAnimator.spec.ts`; keep existing test intents and capture the current pending work. [Source: server/src/match.ts] [Source: client/pixi/TableRenderer.ts]
  - Depends on: none. Done when extraction has a stable comparison set and baseline pass/fail/skip counts, with unrelated existing failures named rather than hidden.
- [x] T002 [P] [Plan:1.1] Add deterministic clock/network/frame/receipt helpers under `testing/timing/` and wire their use through the existing Vitest discovery.
  - Depends on: T001. Done when latency, skew, frame scheduling and queue delay can be varied independently with reproducible seeds.
- [x] T003 [P] [Plan:1.1] Add browser timing validation through host `../../package.json`, `../../scripts/run-tests.mjs`, `../../playwright.config.ts` and `../../tests/e2e/timing/`; retain focused `npm test -- <selectors>` behavior and make full `npm test` discover both the existing Vitest suites and new browser journeys.
  - Depends on: T001. Done when dependencies are intentionally declared before restore, the isolated test service/browser prerequisites are explicit, and no test requires production data or manual setup.

### Phase 2 - Behavior-preserving authoritative extraction

**2.1 Give existing timing/bank state coherent owners without changing policy.** Requirements: REQ-007, REQ-011, REQ-014. Inputs: current match/runtime ownership and the state model in [architecture.md](architecture.md).

- [x] T004 [P] [Plan:2.1] Extract `server/src/timing/timeBank.ts` behind a legacy-policy adapter, retaining current refill/charging/rounding until the separately approved precise-accounting task. [Source: server/src/match.ts#consumeActionBuffer]
  - Depends on: T001, T002. Done when one owner stores bank and existing fixtures still match.
- [x] T005 [Plan:2.1] Extract `server/src/timing/actionWindows.ts` to own legal-window state, timers, starts/kinds and epochs under legacy semantics. [Source: server/src/match.ts#setSeatLegals,handleDeadlineExpiry]
  - Depends on: T004. Done when stale timer callbacks remain fenced and the facade does not maintain parallel duplicate arrays.

**2.2 Split session concerns through typed ports.** Requirements: REQ-006, REQ-009, REQ-012, REQ-013, REQ-014, REQ-016. Inputs: cloud/native behavior, recovery mapping and preserved rules/projection in [architecture.md](architecture.md).

- [x] T006 [Plan:2.2] Extract `server/src/session/matchKernel.ts` for authoritative engine state/driver transitions; keep `rules/` and `duplicate/` untouched. [Source: server/src/match.ts#applyEngineAction,applyDiscard]
  - Depends on: T005. Done when one kernel mutates engine state and ordered emitted effects match baseline.
- [x] T007 [Plan:2.2] Extract `server/src/session/roomRoster.ts` and `server/src/session/playerConnections.ts` for room/host/readiness/owner/liveness concerns. [Source: server/src/match.ts#claimSeat,attachHuman,detachHuman,buildRoomState]
  - Depends on: T006. Done when waiting-seat release, bot replacement and explicit owner transfer are preserved.
- [x] T008 [Plan:2.2] Extract `server/src/session/commandCoordinator.ts` for live command/default handoff and pause barriers, retaining the facade command methods. [Source: server/src/match.ts#handleAct,handleReady,handleAfk,handleVoteContinue]
  - Depends on: T006, T007. Done when queued commands/defaults are serialized without moving receipt policy yet.
- [x] T009 [Plan:2.2] Extract `server/src/session/turnCoordinator.ts` and `server/src/session/callCoordinator.ts`; reuse existing bot and match-driver decisions. [Source: server/src/match.ts#continueDiscardTurn,afterDiscard,openChankanWindow,openCallWindow,afterCall]
  - Depends on: T008. Done when call priority and both pre-/post-bot-pause human-replacement checks survive.
- [x] T010 [Plan:2.2] Extract `server/src/session/handLifecycle.ts` and `server/src/session/sessionCoordinator.ts` for results, readiness, continue votes and Buu ledgers. [Source: server/src/match.ts#afterHandEnd,startNextGame,handleReady,handleVoteContinue]
  - Depends on: T009. Done when hand/session ordering and ledger/archive game indexes match fixtures.
- [x] T011 [Plan:2.2] Extract `server/src/session/eventPublisher.ts` for event sequences, existing projection/redaction, journal and archive composition. [Source: server/src/match.ts#emitEvent,emitEngineEvent,sendToSeat,sendToSpectators,enrichForArchive]
  - Depends on: T006, T007, T010. Done when archives and private/public streams retain their exact semantic events.
- [x] T012 [Plan:2.2] Extract `server/src/session/recoveryCoordinator.ts` and continuation codecs under `server/src/recovery/`, retaining version 4 during this mechanical phase. [Source: server/src/match.ts#createCheckpoint,pauseAndSaveCheckpoint,restoreCheckpoint,restoreSavedCheckpoint]
  - Depends on: T008, T010, T011. Done when command/journal barriers precede a consistent owner snapshot and every existing continuation round-trips.

### Phase 3 - Behavior-preserving renderer extraction

**2.3 Split the shared renderer, preserving its facade and helper exports.** Requirements: REQ-004, REQ-013, REQ-014, REQ-015. Inputs: renderer consumers, concern boundaries and compatibility contract in [architecture.md](architecture.md).

- [x] T013 [P] [Plan:2.3] Extract `client/pixi/scene/sceneGraph.ts`, `client/pixi/scene/rendererAssets.ts` and small readonly render-frame/resource types; move pure exported helpers into `client/pixi/geometry/` with facade re-exports. [Source: client/pixi/TableRenderer.ts#mount,render,destroy]
  - Depends on: T001, T002. Done when assets/disposal/viewport behavior and existing helper imports are unchanged. May run independently of server extraction.
- [x] T014 [Plan:2.3] Extract `client/pixi/renderers/handRenderer.ts` with focused/top/side helpers for hand strips, draw overlays, shadows and layout plans. [Source: client/pixi/TableRenderer.ts#renderSeat]
  - Depends on: T013. Done when source holes, hidden/revealed hands, sort/drag behavior and drawn-tile placement match fixtures.
- [x] T015 [Plan:2.3] Extract `client/pixi/renderers/discardRenderer.ts`, `meldRenderer.ts` and `wallRenderer.ts` with narrow owned caches and shared immutable metrics. [Source: client/pixi/TableRenderer.ts#renderSeat,renderMelds,drawMeld,renderWalls]
  - Depends on: T014. Done when ponds/melds/walls, riichi/call orientation and shadows remain unchanged.
- [x] T016 [Plan:2.3] Extract `client/pixi/results/resultPresenter.ts`, `resultPanels.ts` and small score/stick helpers without changing staged reveal timing. [Source: client/pixi/TableRenderer.ts#renderHandResult,renderMatchEnd,renderResultScoreBoxes]
  - Depends on: T013. Done when result pages, chips, labels and ready-button anchor geometry retain behavior.
- [x] T017 [Plan:2.3] Extract `client/pixi/interaction/interactionController.ts` and `client/pixi/controls/actionControls.ts` for pointer/drag/click/hit-target/control bindings. [Source: client/pixi/TableRenderer.ts#renderActionButtons,setOnTileClick,setOnActionClick]
  - Depends on: T014, T015. Done when callbacks carry the displayed state intent and no legality is duplicated in rendering.
- [x] T018 [Plan:2.3] Extract `client/pixi/hud/actionTimer.ts`, score/name/round/debug HUD components and an action timer view model, without changing countdown policy yet. [Source: client/pixi/TableRenderer.ts#tickTimer,renderScores,renderPlayerNames,renderRoundInfo]
  - Depends on: T013, T016. Done when appearance/countdown cues remain unchanged under the legacy clock adapter.
- [x] T019 [Plan:2.3] Reduce `client/pixi/TableRenderer.ts` to facade/composition/frame orchestration and remove superseded internal state. [Source: client/pixi/TableRenderer.ts]
  - Depends on: T014, T015, T016, T017, T018. Done when all public callers and geometry helpers work without private-state casts or a giant mutable replacement context.

### Phase 4 - Clock reference and additive timing contracts

**3.1 Build clock/quality services for each authority path.** Requirements: REQ-001, REQ-005, REQ-008, REQ-011. Inputs: runtime/transport/state flows in [architecture.md](architecture.md) and the agreed allowance policy.

- [x] T020 [Plan:3.2] Add `protocol/timing.ts` for clock probes/samples, immutable window snapshots, capabilities and per-event presentation metadata; reference it from `protocol/messages.ts`. Keep game/archive events separate from transport-only timing.
  - Depends on: T005, T013. Done when additive schemas validate and legacy frames still parse during shadow rollout.
- [x] T021 [Plan:3.1] Add `server/src/timing/authorityClock.ts` and extend the portable runtime composition for a monotonic compatibility reference, clock epoch and independent calendar time. [Source: server/src/runtime.ts]
  - Depends on: T012, T020. Done when wall-clock changes cannot move a live budget, and PRNG/scheduling portability remains intact.
- [x] T022 [Plan:3.1,3.2] Add `server/src/transport/socketTiming.ts` and clock-probe handling in `server/src/index.ts`; collect bounded correlated authority RTT/quality without relying on browser-visible protocol pongs. [Source: server/src/index.ts#attachHeartbeat,handleClientFrame]
  - Depends on: T021. Done when liveness remains intact, unmatched/stale samples are rejected, and profiles are scoped to the current connection.
- [x] T023 [Plan:3.1,3.2] Add `client/time/serverClock.ts` and `clockSync.ts`, bound through `client/ws.ts`; update the estimate before message observers/store projection. [Source: client/ws.ts]
  - Depends on: T020, T022. Done when offset/uncertainty are monotonic, noisy samples are filtered, and reconnect/foreground invalidate stale quality.
- [x] T024 [Plan:3.1] Add shared timing adapters for host `../../mobile/src/nearby/` and local direct runtime; implement host/guest probes and explicit known-zero-network semantics. [Source: ../../mobile/src/nearby/NearbyMatchController.ts] [Source: ../../mobile/src/local/LocalMatchController.ts]
  - Depends on: T021, T023. Done when no Node/Mongo dependency leaks into the portable timing services.

**3.2 Negotiate the data contract without changing live budgets.** Requirements: REQ-002, REQ-010. T020/T022/T023 provide the schema/clock foundation; activation remains a later gate.

### Phase 5 - Scheduled presentation and decision windows

**4.1 Make readiness and budget one explicit authoritative decision.** Requirements: REQ-002, REQ-003, REQ-009. Inputs: exact current pacing, clarified draw-landing point, existing human/call/declaration continuations.

- [x] T025 [US1] [Plan:4.1,4.2] Add shared `presentation/policy.ts` and `server/src/timing/presentationPlanner.ts`; retain existing constants through compatibility exports and publish canonical sequence-associated starts/landing/readiness.
  - Depends on: T009, T010, T011, T020, T021. Done when the authority derives draw landing D+1000 and maintains the 1200 ms automated cadence without client acknowledgement authority.
- [x] T026 [US1] [Plan:4.1] Evolve `server/src/timing/actionWindows.ts` to scheduled/open/resolved/expired/cancelled state with stable IDs, explicit ends and generation guards; cover each existing timed decision kind.
  - Depends on: T005, T025. Done when every window uses one readiness/policy record and can be shadowed without altering legacy execution.

**4.2 Make presentation and controls consume that contract.** Requirements: REQ-001, REQ-003, REQ-004, REQ-008, REQ-015.

- [x] T027 [US1] [Plan:4.2] Add `client/time/actionWindowViewModel.ts` and project the window in `client/store.ts`/`dispatchServerMessage.ts`; replace HUD wall-clock arithmetic through the extracted timer component. [Source: client/pixi/TableRenderer.ts#tickTimer] [Source: client/dispatchServerMessage.ts]
  - Depends on: T018, T023, T026. Done when countdown and bank projection use the same scheduled window, not locally reset starts.
- [x] T028 [US1] [Plan:4.2] Add `client/presentation/presentationTimeline.ts` and adapt `client/pixi/discardAnimator.ts` to absolute schedule/late-pose reconciliation; keep settle/draw overlap and once-only sound cues. [Source: client/pixi/discardAnimator.ts]
  - Depends on: T019, T025, T027. Done when late frames skip cosmetic remainder rather than begin a full new animation.
- [x] T029 [US1] [Plan:4.2] Gate tile/control usability through `client/pixi/interaction/` and `controls/`; capture action ID, window ID, expected seat and displayed sequence in the intent before transport submission.
  - Depends on: T017, T027, T028. Done when an old displayed action cannot be stamped with a newer store window, and normal draw controls are usable at landing.

### Phase 6 - Receipt fairness, exact bank and recovery

**5.1 Apply one frozen bounded policy to ingress, acceptance and charging.** Requirements: REQ-005, REQ-006, REQ-007, REQ-016.

- [x] T030 [US2] [Plan:5.1] Add `server/src/timing/latencyAllowancePolicy.ts`; compute/freeze adaptive total allowance with 500 ms cap and exact 200 ms unusable-profile fallback.
  - Depends on: T022, T024, T026. Done when new samples cannot extend an existing window and no old grace is stacked onto the cap.
- [x] T031 [US2] [Plan:5.1] Add `server/src/session/inputReceipt.ts` and update cloud, local and Nearby ingress before any awaited operation/command queue; reserve timely inputs with owner/window/generation fencing. [Source: server/src/index.ts#handleClientFrame] [Source: ../../mobile/src/local/LocalMatchController.ts#act] [Source: ../../mobile/src/nearby/NearbyMatchController.ts#routeIncomingMessage]
  - Depends on: T008, T024, T029, T030. Done when a timely reserved action wins over later timeout processing while stale/early/wrong-owner inputs are explicit failures.
- [x] T032 [US2] [Plan:5.1] Activate exact millisecond `TimeBank` charging using the frozen corrected receipt and one debit/resolution; move all rounding into `ActionWindowViewModel`.
  - Depends on: T004, T027, T031. Done when 100 ms billable overage costs exactly 100 ms, not a whole second.

**5.2 Preserve outstanding decisions across clock epochs and recovery.** Requirements: REQ-002, REQ-008, REQ-009, REQ-012.

- [x] T033 [US3] [Plan:5.2] Evolve `server/src/recovery/` and `server/src/checkpoint.ts` to a new explicit version with window identity, contract version, frozen policy and relative readiness/base/expiry durations; retain older checkpoints and legacy pending-command readers.
  - Depends on: T012, T026, T030, T032. Done when every continuation rebases once and expired/bank state is not resurrected.
- [x] T034 [US3] [Plan:5.2] Update snapshot/resync/ownership transfer and local/Nearby restore adapters to restore the same decision and remaining times, invalidating only connection/clock estimates. [Source: server/src/index.ts#handleClientFrame] [Source: server/src/match.ts#buildSnapshotForSeat,restoreSavedCheckpoint]
  - Depends on: T023, T031, T033. Done when reconnect/transfer does not reissue a base budget or frozen allowance.

### Phase 7 - Surface integration, spectator axes and diagnostics

**6.1 Bind all current hosts and presentation modes.** Requirements: REQ-001, REQ-008, REQ-011, REQ-013, REQ-015, REQ-017.

- [x] T035 [US1] [Plan:6.1] Bind web player timing through a small `client/time/liveTimingBinding.ts` adapter in `routes/match.tsx`, keeping game authority outside the Pixi scene.
  - Depends on: T029, T034. Done when window/pose/countdown/input all share the same clock and IDs.
- [x] T036 [US3] [Plan:6.1] Bind native online/local/Nearby through host `../../mobile/src/game/liveTimingBinding.ts` and thin `App.tsx` integration; refresh on foreground without changing local pause semantics.
  - Depends on: T024, T029, T034. Done when all three authority paths preserve their existing lifecycle and ready-ack behavior.
- [x] T037 [US4] [Plan:6.1] Bind `routes/spectate.tsx` and native spectator history with explicit actual presentation offset and baseline/catch-up mode; do not use descriptive upstream source delay as another dispatch offset.
  - Depends on: T028, T035, T036. Done when native delayed streams remain delayed once, external relay streams remain pseudo-live once, and manual history remains immediate.

**6.2 Expose bounded quality and safe activation.** Requirements: REQ-010, REQ-018.

- [x] T038 [US2] [Plan:6.2] Add required timing-capability negotiation in the cloud/native hello paths and explicit incompatible-client terminal errors; keep existing authentication/seat ownership intact.
  - Depends on: T020, T034, T035, T036, T037. Done when incompatible clients cannot silently use different decision rules.
- [x] T039 [US2] [Plan:6.2] Add `server/src/timing/timingDiagnostics.ts` and client diagnostic hooks for epoch/window/profile/ready/receipt/resolution; surface degraded quality without charging from client render reports.
  - Depends on: T031, T035, T036, T038. Done when logs/metrics explain lateness without storing private tile/hand content or trusting client claims.

### Phase 8 - Fairness sign-off and gradual rollout

**7.1 Verify actual usable budgets and preserve the game.** Requirements: REQ-004, REQ-018, REQ-019.

- [x] T040 [Plan:7.1] Complete deterministic timing and owner-level suites under `server/src/timing/`, `client/time/`, `client/presentation/` and `testing/timing/`, including window races, exact bank, offsets, low FPS and frozen allowance boundaries.
  - Depends on: T002, T030, T032, T033, T039. Done when the measured scenarios satisfy SC-001 through SC-008, not only file/field presence.
- [x] T041 [Plan:7.1] Complete real WebSocket/controller/checkpoint integration suites under `server/src/transport/`, `server/src/recovery/` and host `../../mobile/src/{online,local,nearby,persistence}/`; retain existing archive/rules/pacing regressions.
  - Depends on: T034, T037, T038, T040. Done when actual messages, delays, receipt capture and recovery prove the contract.
- [ ] T042 [Plan:7.1] Complete host `../../tests/e2e/timing/` browser journeys and native device checks, measuring info-visible/controls-ready/last-accepted action intervals under network and frame profiles.
  - Depends on: T003, T035, T036, T037, T041. Done when supported profiles meet SC-002 and unsupported conditions are explicit; mocked component timing is not browser sign-off.
  - Software portion verified: 30 real Chromium journeys; eight 30 FPS profiles explicitly deferred by the user. Current-code Android lifecycle/storage, two-device Nearby and iOS remain open. The old installed Android bridge/isolated SQLite round-trip is not current-code acceptance.

**7.2 Review ownership/readability and activate safely.** Requirements: REQ-010, REQ-014, REQ-020.

- [ ] T043 [Plan:7.2] Review domain ownership/facade/module budgets and public callers; complete documentation and activation evidence in `docs/plans/authoritative-timing/`, `README.md` and host `../../mobile/README.md`.
  - Depends on: T019, T038, T039, T040, T041, T042. Done when every requirement has evidence, deliberate policy deltas are named, no duplicated authority/private-context cast remains, and rollback cannot refresh an active authoritative window.
  - Ownership/budgets, required negotiation and checkpoint migration are implemented and tested. Final device/sign-off evidence remains gated by T042 and isolated durable-adapter evidence.

## Proposed project structure

Paths are planned targets, not files created by this packet.

```text
game/
  protocol/
    messages.ts                  existing compatibility/export surface
    timing.ts                    clock/window/presentation DTOs
  presentation/
    policy.ts                    shared mandatory readiness/pacing policy
  server/src/
    match.ts                     public composition facade
    runtime.ts                   portable scheduling/PRNG port
    timing/
      authorityClock.ts
      timeBank.ts
      actionWindows.ts
      presentationPlanner.ts
      latencyAllowancePolicy.ts
      timingDiagnostics.ts
    session/
      matchKernel.ts
      roomRoster.ts
      playerConnections.ts
      commandCoordinator.ts
      inputReceipt.ts
      turnCoordinator.ts
      callCoordinator.ts
      handLifecycle.ts
      sessionCoordinator.ts
      eventPublisher.ts
      recoveryCoordinator.ts
    recovery/
      actionContinuation.ts
      callContinuation.ts
      readyContinuation.ts
      voteContinuation.ts
      resultContinuation.ts
    transport/
      socketTiming.ts
  client/
    ws.ts                        existing facade with clock binding
    time/
      serverClock.ts
      clockSync.ts
      actionWindowViewModel.ts
      liveTimingBinding.ts
    presentation/
      presentationTimeline.ts
    pixi/
      TableRenderer.ts           lifecycle/composition facade and re-exports
      discardAnimator.ts         semantic animation adapter
      scene/                     scene/assets/readonly frame resources
      geometry/                  existing pure helper extractions
      renderers/                 hands/perspectives/ponds/melds/walls
      results/                   staging and result panels
      interaction/               hit-target/drag/hover/click ownership
      controls/                  decision controls and intent identity
      hud/                       timer/score/name/round/debug rendering
  testing/timing/                deterministic reusable test support

host tournament checkout/
  mobile/src/
    game/liveTimingBinding.ts
    online/OnlineMatchController.ts
    local/LocalMatchController.ts
    nearby/                       host/guest clock and message ingress
    persistence/                  existing adapter contract
  tests/e2e/timing/               actual browser journeys and isolated harness
  scripts/run-tests.mjs           durable canonical-test dispatch
  playwright.config.ts
  package.json
```

Do not split merely to create this exact tree. Each concern must justify its state/ports and remain below the agreed readability target; perspective/result helpers can be further divided without changing the owning abstraction.

## Testing strategy

### Scope and environment

- **appType:** mixed Node WebSocket authority plus web/native React/Pixi views and portable local/Nearby authority.
- **Canonical command:** `npm test` runs Vitest with `app/**/*.spec.ts` and `mobile/**/*.spec.ts` discovery, then Chromium when no selectors are supplied. Focused selectors run only the relevant unit/integration tests.
- **Current evidence:** 312 files / 2205 tests and 30 Chromium journeys pass; eight user-deferred 30 FPS profiles skip. Module budgets and the 24-turn pacing/sound regressions remain enforced.
- **Environment:** Node 22.14.0, declared Playwright and installed Chromium are available. Docker is absent; isolated Mongo durability and appropriate current-code native devices remain external gates.

### Primary validation stack

1. Existing Vitest with injected deterministic runtime, fake transport and frame scheduler for exact boundaries/state ownership.
2. Actual Node HTTP/WebSocket service on an ephemeral port with isolated repository/auth fixtures, including real message schema/receipt capture rather than calling only private helpers.
3. Repeatable Playwright TypeScript browser journeys against an isolated web/native-browser host and the test authority. Actual info-visible/controls-ready times must be observed through rendering/interaction, not guessed from DTO presence.
4. Durable recovery adapters: Mongo integration with isolated test data when available; native SQLite/memory contract suites plus real native storage/lifecycle evidence.
5. Android WebView/device lifecycle and Nearby-host/guest checks; iOS-specific compilation/lifecycle evidence on an appropriate macOS/device environment before claiming iOS acceptance.

### Independent capability fallback matrix

| Axis    | Primary                                                                                            | Fallback and required evidence                                                                                                                                                                                | Gap                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Infra   | Isolated Mongo/native durable adapter integration; disposable Docker-managed Mongo where available | Current machine has no Docker command. Use isolated memory repository for clock/transport tests and native SQLite where runnable; record each durable-adapter result separately                               | Memory results do not prove Mongo atomicity or real native filesystem behavior              |
| Browser | Node + declared Playwright package + usable browser binaries                                       | Declare/restore the intentional test dependency at T003, then attempt browser setup. If that specific axis fails, record the exact error and keep HTTP/WS tests; do not drop browser because Docker is absent | HTTP/component results do not prove Pixi rendering, click readiness, frame stalls or assets |
| Native  | Native WebView/device and Nearby peers                                                             | Browser-native entry can exercise shared view/controller code, but cannot replace OS suspension/SQLite/Nearby evidence                                                                                        | Real foreground/background, native storage and radio transport remain unverified            |

Missing capability does not silently reduce a release gate. The acceptance report names gaps and seeks sign-off rather than calling a partial run complete.

### Legacy assets and test infrastructure

- Discovered existing suites: animation/renderer/pacing, runtime/deadline/default handoff, room management, checkpoints/recovery, relay/spectator, transport/store, and native online/local/Nearby/persistence specs.
- Decision: reuse with minimum changes. Move helper imports through compatibility re-exports; do not rewrite passing semantic tests merely because files moved.
- No Playwright/Cypress configuration or `*.e2e.ts` asset was found in the inspected game/mobile source locations. New browser coverage is intentionally scoped, not a claim that a hidden E2E baseline was migrated.
- Shared setup: deterministic authority/client clocks, server/client wall-skew controls, independent outbound/inbound/frame/queue delays, receipt capture, unique match IDs and clear teardown.
- External dependencies: game rules are real/preserved; repository/auth are isolated fixtures in pure timing/transport tests; durable-adapter suites use real isolated stores; production credentials/data are never test prerequisites.
- Frontend/backend contract tests validate actual clock/window/presentation DTOs and compatibility negotiation. Do not substitute successful-looking stubs for rejected windows or invalid recovery.
- Every implementation task runs the smallest relevant suites and records exit code plus pass/fail/skip counts. A new failure blocks the task; no deferral to a final validation phase.

### Required journeys

| Journey                    | Setup/action                                                     | Required result                                                                                    |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Normal usable discard      | Draw, mandatory landing, decision, submit                        | Budget begins at readiness; full base exists; exact bank debit and one resolution                  |
| Call/fixed decisions       | Competing calls or tenpai/noten with effects                     | Per-seat windows and existing priority/default/bank eligibility, independent of response order     |
| Network/device differences | Skew/jitter/RTT/FPS profiles                                     | Stable reference, correct ready pose, bounded frozen allowance and supported usable-time tolerance |
| Receipt/default race       | Receive before/at/after expiry while queues/defaults are delayed | Ingress timing plus identity/generation determine the result; no extra budget or stale action      |
| Reconnect/takeover/restore | Switch owners/epochs and pause/resume                            | Same outstanding decision and remaining time, no double debit or revived expiry                    |
| Spectator/replay           | Native delayed, external relay, live versus manual history       | Correct presentation axis/offset; no private/unripe release or extra five-minute delay             |
| Structural fidelity        | Run baseline before/after each extraction                        | Rules/projection/archive/interaction/layout/sound outcomes preserved                               |

### Fairness matrix and measurements

- Controlled supported profiles: RTT 0/100/300 ms, jitter up to 50 ms, one-way asymmetry up to 50 ms, at least 30 FPS.
- The 30 FPS Playwright profile is deferred at the user's request. Keep normal-frame-rate browser measurements and deterministic low-FPS/stall tests, but neither substitutes for 30 FPS browser acceptance.
- Stress/degraded profiles: higher RTT up to and beyond the 500 ms allowance envelope, asymmetric paths, burst delivery, 15/5 FPS, UI thread stalls, background/resume, missing/noisy samples.
- Clock profiles: plus/minus five-minute device error, wall-clock steps, monotonic progression, new epoch, stale and reordered samples.
- Exact boundaries: one millisecond before/at/after readiness/base/bank/expiry, 0/500 ms allowance and exact 200 ms fallback, 100 ms overage, changed quality mid-window.
- Record authority `infoSentAt`, scheduled readiness, window ends, frozen profile, receipt and resolution; record client info-visible/control-ready/action-submitted observations for diagnostics only.
- Measure usable decision interval and accepted input, not just an animation's duration or a presence of fields in a packet.
- Preserve 24-turn automated cadence and every discard/draw landing cue once.

### Data, cleanup and review expectations

Use deterministic boards/seeds and unique ephemeral match/storage identifiers. Close only test-owned sockets/services, clean explicitly named fixtures, and never touch live databases or another user's processes.

The reviewer checks spec coverage, extraction fidelity, all host paths, exact accounting, capability/version behavior, native/browser gaps and declared source scope. Build/type/lint success is necessary but not proof of usable think time.

## Activation and rollback

1. Validate all readiness and exact-accounting deltas under the matrix.
2. Require player clients to negotiate `clock-window-v2` plus the additive
   `fixedPromptVersion: 1` field.
3. Preserve existing checkpoints and their known remaining values by migrating
   versions 1-6 into the version-7 authoritative window format.
4. A rollback of unrelated releases must not refresh an existing explicit
   window or drop compatible checkpoint readers.
5. Remove internal extraction wrappers after caller migration, not old
   archive/checkpoint readers as incidental cleanup.

`GAME_TIMING_DIAGNOSTICS=true` enables bounded structured diagnostics without
changing enforcement.

## Requirement mapping

Implementation evidence below is planned completion evidence, not a claim that modules already exist.

| REQ ID  | Description                                              | Plan items             | Planned evidence                                                            |
| ------- | -------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| REQ-001 | Shared authority clock reference                         | P3.1, P4.2, P6.1       | authorityClock, ServerClock, ActionWindowViewModel and web/native bindings  |
| REQ-002 | One explicit decision identity/lifecycle                 | P3.2, P4.1, P5.2       | timing DTOs, ActionWindowRegistry and recovery continuation                 |
| REQ-003 | Normal clock starts after usable landing                 | P4.1, P4.2             | PresentationPolicy/planner, ready control/pose and measured usable interval |
| REQ-004 | Preserve accepted pacing/bot fixes                       | P1.1, P2.3, P4.2, P7.1 | Existing animation/sound/cadence fixtures and 24-turn matrix                |
| REQ-005 | Frozen adaptive 500 ms cap/200 ms fallback               | P3.1, P5.1             | Socket/Nearby quality profiles and LatencyAllowancePolicy boundaries        |
| REQ-006 | Trusted ingress and timeout arbitration                  | P2.2, P5.1             | InputReceipt, CommandCoordinator and all ingress adapters                   |
| REQ-007 | Exact bank and once-only debit                           | P2.1, P5.1             | TimeBank, pure HUD projection and 100 ms overage/retry tests                |
| REQ-008 | No reset on lateness/recovery                            | P3.1, P4.2, P5.2, P6.1 | Clock quality lifecycle, pose reconciliation and same-window resume         |
| REQ-009 | All timed window kinds/priority                          | P2.2, P4.1, P5.2       | Call/hand/session coordinators and continuation/window kind matrix          |
| REQ-010 | Separable extraction/activation and pinned version       | P1.1, P3.2, P6.2, P7.2 | Baseline, capability/mode negotiation and shadow/activation gates           |
| REQ-011 | Web/native/local/Nearby portability                      | P2.1, P3.1, P6.1       | Portable timing ports, local identity and host/guest/online adapters        |
| REQ-012 | Durable identity/policy/remaining-time recovery          | P2.2, P5.2             | RecoveryCoordinator, new checkpoint version and v1-v4 adapters              |
| REQ-013 | Rules/projection/archive/raw delivery preserved          | P1.1, P2.2, P2.3, P6.1 | Frozen rules seams, event publisher and semantic regression traces          |
| REQ-014 | Small cohesive single-owner modules                      | P2.1, P2.2, P2.3, P7.2 | Ownership review, facade budgets and no private mutable mega context        |
| REQ-015 | Renderer/manual-history fidelity                         | P2.3, P4.2, P6.1       | Domain renderer/interaction/result/HUD components and visual journeys       |
| REQ-016 | Room/owner/default/journal/error fidelity                | P1.1, P2.2, P5.1       | RoomRoster, PlayerConnections, CommandCoordinator and journal fixtures      |
| REQ-017 | Correct spectator/external presentation axis             | P6.1                   | Spectator timing binding and native-delayed/external-relay tests            |
| REQ-018 | Correlated diagnostics not client authority              | P6.2, P7.1             | Timing diagnostics, degraded notices and measured fairness report           |
| REQ-019 | Dedicated usable-time matrix                             | P1.1, P7.1             | Deterministic, real WS/controller and browser/native journeys               |
| REQ-020 | Incremental gates/rollback and no hidden duplicate state | P1.1, P7.2             | Per-task evidence, ownership/compatibility review and mode rollback         |

# Feature specification: authoritative decision timing and modular game code

Implementation constraints and agreed decisions: [plan.md](plan.md#constraints). Existing architecture and preservation boundaries: [architecture.md](architecture.md).

Created: 2026-10-01. Status: ready for implementation planning, not implemented.

Input: plan the agreed clock/window recommendations without a private-information reveal phase; also split the large match and renderer implementations into smaller, readable concerns.

## Scope baseline

- Discovery: prior timing discussion, current source inspection, and the scoped [architecture brief](architecture.md).
- Four existing runtime surfaces were discovered and are in scope: cloud sessions, the web player, the web spectator, and the native shell's online/local/Nearby paths.
- Shared authoritative orchestration, client transport/state, presentation and recovery are in scope where these surfaces use them.
- The user explicitly selected broad match/renderer modularization, discard clocks beginning after draw landing, adaptive allowance capped at 500 ms with 200 ms fallback, and dedicated fairness/regression tests.
- This packet is planning-only. Existing uncommitted spectator/pacing work remains the baseline.

### Exclusions

- No private-information reveal phase or change to when raw private information is delivered.
- No rules/scoring/preset/duplicate-board redesign, framework migration, FPS rollback engine, external relay decoder rewrite, or unrelated portal/native home/auth/library refactor.
- No claim of perfect equal human-visible time under arbitrary latency, stalls or modified clients.
- No commit, push, deployment or runtime-code implementation by this task.

## User scenarios and testing

### US1 - A full useful decision budget (P1)

A player receives the normal decision budget once the drawn tile has landed and controls are usable, rather than paying for mandatory presentation.

Why this priority: changing cosmetic timings must not silently shorten a timed decision.

Independent test: observe the decision-ready transition and the accepted action interval without changing gameplay rules.

Acceptance scenarios:

1. Given a normal draw, when the tile lands and controls become usable, then the decision budget starts at that agreed point; unrelated settling may continue.
2. Given a call or fixed declaration, when its required information/controls are usable, then that window follows its defined readiness point and existing bank eligibility.
3. Given a decision resolved by another valid transition, when an old input or timeout arrives, then it cannot affect the next decision.

### US2 - Consistent clocks despite network and device differences (P1)

A web or native-online player sees a countdown based on the authoritative clock and receives bounded, explicit latency treatment.

Independent test: run identical decisions with clock skew, jitter and a known network profile and compare usable budgets and accepted inputs.

Acceptance scenarios:

1. Given a device wall-clock error or correction, when a decision is displayed, then the game countdown does not jump or gain budget.
2. Given usable measured latency, when a window opens, then its allowance is frozen and never exceeds 500 ms.
3. Given no usable latency measurements, when a networked window opens, then its allowance is 200 ms.
4. Given a late message or low frame rate, when relevant state arrives, then cosmetic work is shortened/skipped rather than replayed from arrival while a new full animation consumes decision time.

### US3 - Resume and transport portability (P1)

A player can reconnect, transfer control, resume a local game, or play Nearby without restarting a decision clock or losing exact bank accounting.

Independent test: save and restore an active decision or reconnect another client session, then compare identity and remaining budget.

Acceptance scenarios:

1. Given an outstanding decision, when a player reconnects or explicitly transfers control, then its remaining budget is retained and old-session inputs remain fenced.
2. Given a paused local or Nearby-host game, when it resumes from durable state, then remaining durations are rebased once and bank is charged at most once.
3. Given a Nearby command or local queued operation, when processing is delayed internally, then that queueing delay is not attributed to player thinking.

### US4 - Maintainable code without game/presentation drift (P2)

Maintainers can locate one owner for a concern and change it without working through unrelated game or drawing logic.

Independent test: structurally extract a concern, compare existing behavior traces/fixtures, and preserve callers through the existing facades.

Acceptance scenarios:

1. Given an extraction-only increment, when existing command/render/recovery flows run, then rules outcomes, projection, sounds, interactions and archives remain unchanged.
2. Given manual replay or an external relay, when presentation runs, then player decision clocks are not introduced and source delay is not applied twice.
3. Given a timing-policy change, when the feature is shadowed or a legacy client connects, then an entire match keeps one pinned timing version rather than silently mixing budgets.

### Edge cases

- A timer callback races an already-received input or an in-flight command/default.
- Clock quality changes after a window has opened.
- A valid command reaches the authority before expiry but executes after internal queueing.
- A connection is replaced while an action is pending.
- Several call windows coexist and Mahjong priority differs from arrival order.
- A checkpoint restores after a long suspension or into a new clock epoch.
- A fixed declaration has no per-hand bank.
- A stream is native-delayed versus an already-delayed external relay.
- A client cannot meet the supported rendering/network envelope.
- Private data already delivered can be read before the planned visual point; eliminating that advantage is outside this requested scope.

## Requirements

### Functional requirements

- **REQ-001**: All live timed surfaces MUST derive their countdown/presentation reference from the authority rather than device wall-clock assumptions.
- **REQ-002**: Each decision MUST have one authoritative identity, readiness point, base end, remaining bank where applicable, expiry, and lifecycle.
- **REQ-003**: A normal discard decision budget MUST begin after the drawn tile has landed and controls are fully usable; unrelated cosmetic settling MUST NOT postpone it.
- **REQ-004**: The accepted 500/700 ms server pacing and 250/450/150/300 ms presentation timings, 500 ms visual minimum, and bot landing/sound fixes MUST remain intact.
- **REQ-005**: Networked decision allowance MUST be server-controlled, adaptive to usable measurements, frozen per window, capped at 500 ms total, and 200 ms when measurements are unusable. Client acknowledgements MUST NOT extend it.
- **REQ-006**: Input acceptance and charging MUST use authority-captured arrival time before asynchronous processing, with decision/session fencing and deterministic timeout/default arbitration.
- **REQ-007**: Thinking-bank accounting MUST retain exact milliseconds and debit once; display rounding MUST NOT remove additional earned time.
- **REQ-008**: Late delivery, reconnect, takeover, clock refresh and foreground recovery MUST NOT create a new budget for the same decision; cosmetic backlog MUST NOT hold relevant information/controls past readiness.
- **REQ-009**: The window contract MUST cover existing human discard/call/fixed-declaration windows and timed readiness/votes while retaining their bank eligibility, defaults and Mahjong resolution priority.
- **REQ-010**: Structural extraction and timing activation MUST remain separable; upgraded matches MUST pin one negotiated timing version and incompatible players MUST not silently receive different rules.
- **REQ-011**: The design MUST support web, native online, known-zero-network local input and Nearby host/guest authority without introducing host-only dependencies into shared game code.
- **REQ-012**: Durable recovery MUST preserve decision identity, exact bank, frozen allowance and remaining phase/budget/expiry durations, with explicit migration from existing checkpoint formats.
- **REQ-013**: Rules outcomes, private/public projection, duplicate determinism, archive/replay meaning, external decoder behavior and current raw-information delivery MUST be preserved.
- **REQ-014**: Match orchestration and table rendering MUST be divided into readable domain-focused concerns with one mutable-state owner each, narrow typed boundaries and preserved external facades.
- **REQ-015**: Renderer extraction MUST preserve layouts/assets, hit targets/dragging, sounds, result staging, viewport behavior and immediate manual-history navigation.
- **REQ-016**: Server extraction MUST preserve waiting-room/host/bot-replacement behavior, ownership/takeover, serialized commands/defaults, asynchronous journals and explicit durable-error handling.
- **REQ-017**: Spectator presentation MUST distinguish actual dispatch delay from informational upstream delay, never introduce player clocks or release future/unripe state, and never double-delay an external relay.
- **REQ-018**: Timing decisions MUST be observable with window/connection/clock-epoch correlation and low-quality/late-state diagnostics; client observations are telemetry, not authority.
- **REQ-019**: Dedicated fairness validation MUST measure usable thinking intervals and accepted inputs under latency, jitter, clock skew, frame-rate variation, races and recovery, not only equal animation durations.
- **REQ-020**: Every structural/behavioral increment MUST have a measurable completion gate and a rollback/shadow boundary; compatibility wrappers MUST not hide duplicated authority or invalid recovery.

### Key entities

- Decision window: a particular player's decision and its identity, readiness, budget and resolution.
- Thinking bank: the exact remaining per-hand allowance.
- Presentation schedule: the intended visible readiness of relevant information and controls.
- Clock reference/epoch: the authority time reference and its lifetime.
- Connection-quality profile: measured network quality used to choose a bounded allowance.
- Input receipt: an authenticated authority-side arrival record associated with a window.
- Recovery continuation: the relative remaining durations and state needed to resume without a new budget.

## Success criteria

These are acceptance targets for future implementation, not measured results of this planning task.

- **SC-001**: Deterministic scenarios charge zero thinking time before decision readiness and grant the full 5000 ms base budget after it.
- **SC-002**: In supported controlled profiles (RTT 0/100/300 ms, jitter up to 50 ms, one-way asymmetry up to 50 ms, rendering at least 30 FPS), usable base time differs from 5000 ms by no more than 100 ms and countdown error stays within 100 ms after synchronization.
- **SC-003**: Changing a device wall clock by plus/minus five minutes neither replenishes nor consumes an authoritative budget.
- **SC-004**: Every allowance is in [0,500] ms; unusable network profiles select exactly 200 ms; mid-window samples never move its expiry.
- **SC-005**: A 100 ms billable overage debits 100 ms, not a whole second; reconnect/restore/retry never debit the same overage twice.
- **SC-006**: Deterministic boundary cases distinguish arrival just before/at/after expiry, stale window/session and timer-generation races without applying an action to the wrong decision.
- **SC-007**: Twenty-four consecutive automated turns preserve the 1200 ms cadence, each landing cue exactly once and no accumulating catch-up backlog.
- **SC-008**: Pause/resume and explicit transfer retain the outstanding decision and its known remaining budget in every supported host path.
- **SC-009**: Normal/live/manual/delayed/external-relay rendering retains the existing meaning and role restrictions; a relay that is already delayed receives no additional five-minute presentation delay.
- **SC-010**: Maintainers can identify the sole owner of window, bank, roster, engine, command, recovery, scene, interaction and presentation state, with no copied mutation state or private-facade access.
- **SC-011**: The match and renderer facades target at most 800 source lines each; new active handwritten concern modules target at most 500 lines. Static asset/catalog data and necessary compatibility re-exports are excluded from the module target, not used to game it.
- **SC-012**: All scoped behavior-preservation and fairness journeys have passing evidence before new timing is enabled; planning/schema coverage alone is not runtime sign-off.

## Assumptions and limitations

- The five-second base and twenty-second per-hand bank remain the current defaults; fixed declaration/readiness/vote windows retain their own policy.
- A private reveal phase is explicitly excluded. Honest-client usability improves, but a modified client can still inspect already-delivered data early.
- Frozen allowance is a bounded estimate, not proof of exact one-way delay. Unsupported latency/rendering conditions are diagnosed rather than promised identical human-visible time.
- Local direct input has known no-network semantics; absence of a network is not confused with an unknown network profile.
- Clock/window protocol activation will be staged and capability-negotiated. Existing live games and old durable data remain legible.
- Broad refactoring means extracting the actual domain concerns of the two large facades; it does not authorize changing unrelated gameplay or native shell domains.
- Test-tool additions, if needed later, are intentional test infrastructure and must be wired into the common commands; no tools/dependencies are installed by this planning task.

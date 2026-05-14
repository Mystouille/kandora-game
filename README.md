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
  - `~/db/models/**` — shared Mongoose schemas (day-one shortcut; see plan).
    The flat `~/db/*` files (e.g. `~/db/User`) are portal-only and must
    not be imported from the game subtree. ESLint enforces the broader
    boundary; the `db/models/` distinction is enforced in code review
    (the built-in `no-restricted-imports` rule cannot express the
    "allow this subdirectory" exception).
  - `~/game/portal-adapter/**` — the single integration seam.
  - `config` — only via `~/game/feature-gate` (the `config` import is
    blocked everywhere else in the game subtree).
- **All cross-cutting concerns go through `PortalAdapter`.** Auth
  verification, user profile lookups, optional match-end notifications.
  See [`portal-adapter/types.ts`](./portal-adapter/types.ts) for the
  interface, [`portal.ts`](./portal-adapter/portal.ts) for the
  portal-backed implementation, and [`standalone.ts`](./portal-adapter/standalone.ts)
  for the stub that documents what the standalone build must do.
- **No UI imports from portal components.** Game UI lives entirely under
  `app/game/components/` and may reuse the shared design tokens
  (Tailwind config, CSS variables) but not concrete portal components.

The ESLint `no-restricted-imports` rule scoped to `app/game/**` and
`game-server/**` enforces these boundaries with severity `error`. Do not
weaken the rule to land a feature — refactor through the adapter instead.

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
  components/                  ← table UI, replay viewer, lobby
  routes/                      ← portal-side React Router entries
  README.md                    ← this file
```

`game-server/` is a sibling top-level directory: the standalone Node
process that runs match sessions. It speaks the same `protocol/` and
consumes the same `PortalAdapter`.

/**
 * Per-recipient projection — redacts private info from a `GameEvent`
 * before it is sent to a particular seat.
 *
 * Returning `null` means "drop this event entirely for this recipient"
 * — the per-seat seq line in `MatchProcess` does not advance for
 * dropped events, so each recipient's wire stream remains strictly
 * contiguous from their own perspective.
 *
 * Recipient kinds:
 *   - `Seat` (0..3) — a player at the table. They see their own
 *     hand on `hand_start` (the caller re-attaches it after
 *     projection), their own draws, and every public event.
 *   - `"spectator"` — a third-party live or delayed observer.
 *     Spectators are **omniscient** in this product: they see
 *     every seat's hand, every drawn tile, every furiten
 *     transition, and the full wall layout (live + dead) at the
 *     start of each hand. Nothing is redacted for spectators.
 *
 * Slice rule set:
 *   - `draw`:  for a Seat recipient, the drawn `tile` is included
 *              only when the recipient is the drawer. For
 *              spectators, the tile is always included.
 *   - `hand_start`: for a Seat recipient, the recipient's own
 *              initial 13 tiles are sent and the caller
 *              re-attaches them after projection; opponents stay
 *              redacted. For spectators, the archived event is
 *              forwarded verbatim, so `startingHands` (all four
 *              hands) and `liveWall` / `deadWall` /
 *              `liveDrawSchedule` (wall reveal overlay) are all
 *              included.
 *   - `furiten`: for a Seat recipient, only sent to the affected
 *              seat (opponent furiten is private). For
 *              spectators, every furiten transition is forwarded
 *              so the observer can render the indicator.
 *   - All other event types are public in the slice.
 */
import type { GameEvent, Seat } from "~/game/protocol/messages";

/**
 * Projection target. A numeric `Seat` is a player; `"spectator"`
 * is the omniscient-but-archival-stripped view used by live /
 * delayed spectators and by the replay viewer's live-projection
 * mode.
 */
export type Recipient = Seat | "spectator";

export function projectEvent(
  event: GameEvent,
  recipient: Recipient
): GameEvent | null {
  switch (event.type) {
    case "draw": {
      if (recipient === "spectator" || event.seat === recipient) {
        return event;
      }
      return { ...event, tile: undefined };
    }
    case "hand_start": {
      // Players: the caller (`MatchProcess.projectForSeat`)
      // re-attaches the recipient's own hand after projection,
      // so we simply forward the wire event as-is. The wire copy
      // is bare (no `startingHands` / `liveWall` / `deadWall` /
      // `liveDrawSchedule`) because `emitEvent` passes the
      // pre-enrichment event to per-seat dispatch.
      //
      // Spectators: forward the **archived** event verbatim. They
      // are omniscient in this product so they see every
      // omniscient field — `startingHands` powers the all-hands
      // table view, and `liveWall` / `deadWall` /
      // `liveDrawSchedule` power the wall-reveal overlay.
      return event;
    }
    case "furiten": {
      // Furiten state is private to the affected seat for other
      // players (leaking it would tell opponents that a passed-on
      // tile was a ron-wait). Spectators are omniscient and see
      // every transition.
      if (recipient === "spectator") {
        return event;
      }
      if (event.seat !== recipient) {
        return null;
      }
      return event;
    }
    default: {
      return event;
    }
  }
}

/**
 * Convenience wrapper for the spectator projection path.
 * Equivalent to `projectEvent(event, "spectator")` but reads at
 * the call site as a deliberate "to spectator" step rather than a
 * polymorphic dispatch. Use this from live-spectator WS fan-out,
 * delayed-spectator tape replay, and the replay viewer's
 * spectator-view toggle.
 */
export function projectPublicEvent(event: GameEvent): GameEvent | null {
  return projectEvent(event, "spectator");
}

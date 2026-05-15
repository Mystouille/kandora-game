/**
 * On-demand replay-log fetcher for the `/replays/:gameId` route.
 *
 * Background: the Phase 4.5 hydration cycle is what normally fills
 * the `replaylogs` collection — it walks the `games` collection and
 * calls `connector.getReplayLog(gameId)` for each game that doesn't
 * yet have a `replayLogRef`. That cycle only covers ids that already
 * belong to a registered league/tournament `Game` doc.
 *
 * This helper is the fallback path the replay route takes when a
 * user lands on a `gameId` that doesn't have a row yet: dispatch to
 * the right connector by source, fetch + parse the platform log,
 * upsert it into `replaylogs` (without any `Game` link — these are
 * "orphan" logs, fine for now), and return the freshly-parsed log
 * so the loader can render immediately.
 *
 * Source dispatch mirrors the production hydration code path in
 * `GameHydrationService.server.ts` — the only difference is we
 * don't have a `League` object handy, so we map the
 * `ReplaySource` enum onto the right connector singleton directly.
 */
import { ReplayLogModel } from "~/db/models/ReplayLog";
import type { ReplayLog, ReplaySource } from "~/game/replay/types";
import { MajsoulLeagueConnector } from "~/services/connectors/MajsoulLeagueConnector.server";
import { TenhouLeagueConnector } from "~/services/connectors/TenhouLeagueConnector.server";
import { RiichiCityLeagueConnector } from "~/services/connectors/RiichiCityLeagueConnector.server";

async function fetchFromPlatform(
  source: ReplaySource,
  gameId: string
): Promise<ReplayLog | null> {
  switch (source) {
    case "majsoul":
      return MajsoulLeagueConnector.instance.getReplayLog(gameId);
    case "tenhou":
      return TenhouLeagueConnector.instance.getReplayLog(gameId);
    case "riichicity":
      return RiichiCityLeagueConnector.instance.getReplayLog(gameId);
    case "ingame":
      // In-app games are written directly by the game-server's
      // `archiveReplayLog`; if the row isn't there, there's nothing
      // to fetch on-demand.
      return null;
    default:
      return null;
  }
}

/**
 * Fetch + parse the platform log for `(source, gameId)` and upsert
 * an orphan `ReplayLog` row. Returns `null` when the platform has no
 * such game (or fetching fails) so the loader can 404 cleanly.
 *
 * The `Game.replayLogRef` link is deliberately not touched —
 * orphan logs aren't tied to a registered game, and the next
 * hydration cycle (if a `Game` doc shows up later) will pick the
 * existing row up by its `(source, sourceGameId)` unique index.
 */
export async function fetchOrphanReplayLog(
  source: ReplaySource,
  gameId: string
): Promise<ReplayLog | null> {
  const log = await fetchFromPlatform(source, gameId);

  if (!log) {
    return null;
  }

  try {
    await ReplayLogModel.findOneAndUpdate(
      { source: log.source, sourceGameId: log.sourceGameId },
      {
        $set: {
          source: log.source,
          sourceGameId: log.sourceGameId,
          ruleSet: log.ruleSet,
          ruleSetDetails: log.ruleSetDetails,
          startedAt: log.startedAt,
          endedAt: log.endedAt,
          seats: log.seats,
          events: log.events,
          schemaVersion: log.schemaVersion,
          parsedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    // Persistence failure isn't fatal — we still have the parsed
    // log in memory, so return it and the next request will try
    // the upsert again.
    console.error(
      `fetchOrphanReplayLog: upsert failed for ${log.source}/${log.sourceGameId}`,
      error
    );
  }

  return log;
}

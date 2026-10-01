import type { EventJournalErrorContext } from "../eventJournal";
import type { MatchEventJournalStore, MatchRepository } from "../repository";
import type { MatchRuntime } from "../runtime";
import type { AutomaticActionContext } from "../session/sessionTypes";
import type { AuthorityClock } from "../timing/authorityClock";
import type { TimingObserver } from "../timing/timingDiagnostics";

export interface MatchProcessDependencies {
  repository: MatchRepository;
  eventJournalStore?: MatchEventJournalStore;
  onEventJournalError?: (context: EventJournalErrorContext) => void;
  onAutomaticAction?: (context: AutomaticActionContext) => void;
  runtime?: MatchRuntime;
  authorityClock?: AuthorityClock;
  onTimingDiagnostic?: TimingObserver;
}

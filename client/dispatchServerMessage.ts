import type { ServerMessage } from "~/game/protocol/messages";
import { useMatchStore } from "./store";

export interface ServerMessageDispatchOptions {
  onError?: (code: string, message: string) => void;
  onSequenceGap?: (gap: { expectedSeq: number; receivedSeq: number }) => void;
}

/** Apply one validated server frame to the shared live-match store. */
export function dispatchServerMessage(
  message: ServerMessage,
  options: ServerMessageDispatchOptions = {}
): void {
  const store = useMatchStore.getState();
  switch (message.type) {
    case "snapshot": {
      store.hydrateSnapshot(message.state, message.seq);
      store.setLegalActions(message.legalActions);
      store.setActionDeadline(message.deadline ?? null);
      store.setActionBufferMs(message.bufferMs ?? null);
      return;
    }
    case "event": {
      const lastSeq = useMatchStore.getState().lastSeq;
      if (message.events.length === 0) {
        if (message.seq < lastSeq) {
          return;
        }
        if (message.seq > lastSeq) {
          options.onSequenceGap?.({
            expectedSeq: lastSeq + 1,
            receivedSeq: message.seq,
          });
          return;
        }
        store.setLegalActions(message.legalActions);
        store.setActionDeadline(message.deadline ?? null);
        store.setActionBufferMs(message.bufferMs ?? null);
        return;
      }

      const startSeq = message.seq - message.events.length + 1;
      const expectedSeq = lastSeq + 1;
      if (message.seq < expectedSeq) {
        return;
      }
      if (startSeq > expectedSeq) {
        options.onSequenceGap?.({
          expectedSeq,
          receivedSeq: startSeq,
        });
        return;
      }

      const unseenOffset = Math.max(0, expectedSeq - startSeq);
      message.events.slice(unseenOffset).forEach((event, index) => {
        store.applyEvent(event, startSeq + unseenOffset + index);
      });
      store.setLegalActions(message.legalActions);
      store.setActionDeadline(message.deadline ?? null);
      store.setActionBufferMs(message.bufferMs ?? null);
      return;
    }
    case "error": {
      options.onError?.(message.code, message.message);
      return;
    }
    case "ready_check": {
      store.setActionDeadline(null);
      store.setActionBufferMs(null);
      store.setReadyCheck({
        deadline: message.deadline,
        acked: message.acked,
      });
      return;
    }
    case "ready_check_end": {
      store.setReadyCheck(null);
      return;
    }
    case "room_state": {
      store.setRoomState(message);
      return;
    }
    case "room_kicked": {
      return;
    }
    case "spectate_redirect": {
      return;
    }
    case "session_replaced": {
      return;
    }
    case "viewer_state": {
      store.setViewers(message.viewers);
      return;
    }
    case "keepalive": {
      return;
    }
  }
}

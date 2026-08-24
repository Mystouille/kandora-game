import type { ServerMessage } from "~/game/protocol/messages";
import { useMatchStore } from "./store";

export interface ServerMessageDispatchOptions {
  onError?: (code: string, message: string) => void;
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
      const startSeq = message.seq - message.events.length + 1;
      message.events.forEach((event, index) => {
        store.applyEvent(event, startSeq + index);
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
    case "viewer_state": {
      store.setViewers(message.viewers);
      return;
    }
    case "keepalive": {
      return;
    }
  }
}

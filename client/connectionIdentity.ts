import { ClientSessionIdSchema } from "~/game/protocol/messages";

const STORAGE_KEY = "kandora_game_client_session_id_v1";

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createGameClientSessionId(): string {
  return crypto.randomUUID();
}

function browserSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getOrCreateGameClientSessionId(
  storage: SessionStorageLike | null = browserSessionStorage(),
  createId: () => string = createGameClientSessionId
): string {
  if (storage !== null) {
    try {
      const existing = storage.getItem(STORAGE_KEY);
      if (
        existing !== null &&
        ClientSessionIdSchema.safeParse(existing).success
      ) {
        return existing;
      }
    } catch {
      // Fall back to an in-memory ID for storage-restricted environments.
    }
  }

  const created = ClientSessionIdSchema.parse(createId());
  if (storage !== null) {
    try {
      storage.setItem(STORAGE_KEY, created);
    } catch {
      // The returned ID still fences reconnects for this GameWS instance.
    }
  }
  return created;
}

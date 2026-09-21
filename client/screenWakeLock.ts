import { useEffect } from "react";

export interface ScreenWakeLockSentinel {
  release(): Promise<void>;
}

export interface ScreenWakeLockApi {
  request(type: "screen"): Promise<ScreenWakeLockSentinel>;
}

export interface ScreenWakeLockDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function installScreenWakeLock(
  wakeLock: ScreenWakeLockApi,
  visibilityDocument: ScreenWakeLockDocument
): () => void {
  let sentinel: ScreenWakeLockSentinel | null = null;
  let requestGeneration = 0;
  let disposed = false;

  const releaseCurrent = (): void => {
    const current = sentinel;
    sentinel = null;
    if (current !== null) {
      void current.release().catch(() => undefined);
    }
  };

  const request = (): void => {
    if (
      disposed ||
      sentinel !== null ||
      visibilityDocument.visibilityState !== "visible"
    ) {
      return;
    }
    const generation = ++requestGeneration;
    void wakeLock
      .request("screen")
      .then((nextSentinel) => {
        if (
          disposed ||
          generation !== requestGeneration ||
          visibilityDocument.visibilityState !== "visible"
        ) {
          void nextSentinel.release().catch(() => undefined);
          return;
        }
        sentinel = nextSentinel;
      })
      .catch(() => undefined);
  };

  const handleVisibilityChange = (): void => {
    requestGeneration += 1;
    if (visibilityDocument.visibilityState === "visible") {
      request();
    } else {
      releaseCurrent();
    }
  };

  visibilityDocument.addEventListener(
    "visibilitychange",
    handleVisibilityChange
  );
  request();

  return () => {
    disposed = true;
    requestGeneration += 1;
    visibilityDocument.removeEventListener(
      "visibilitychange",
      handleVisibilityChange
    );
    releaseCurrent();
  };
}

export function useScreenWakeLock(): void {
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: ScreenWakeLockApi })
      .wakeLock;
    if (wakeLock === undefined || typeof wakeLock.request !== "function") {
      return;
    }
    return installScreenWakeLock(wakeLock, document);
  }, []);
}
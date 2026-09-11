import {
  CloseOutlined,
  LoadingOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isGameSoundEnabled, setGameSoundEnabled } from "./sound";

interface WebTableTopControlsProps {
  compactLayout: boolean;
  onCompactLayoutChange: (compactLayout: boolean) => void;
  onQuit: () => void;
  quitLabel: string;
  children?: ReactNode;
}

export const WEB_TABLE_TOP_CONTROL_CLASS =
  "h-11 inline-flex items-center justify-center rounded border border-transparent bg-black/70 text-emerald-100 text-base font-medium shadow-sm transition-[background-color,color,border-color,box-shadow,transform] duration-150 ease-out hover:border-emerald-400/60 hover:bg-emerald-800 hover:text-white hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black active:translate-y-px active:scale-[0.96] active:bg-emerald-950 active:text-white active:shadow-inner motion-reduce:transition-none motion-reduce:transform-none";

export function WebTableTopControls({
  compactLayout,
  onCompactLayoutChange,
  onQuit,
  quitLabel,
  children,
}: WebTableTopControlsProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [quitRequested, setQuitRequested] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSoundEnabled(isGameSoundEnabled());
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !settingsRef.current?.contains(event.target)
      ) {
        setSettingsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  return (
    <div className="pointer-events-auto absolute right-2 top-2 z-[130] flex items-center gap-2">
      {children}
      <div ref={settingsRef} className="relative">
        <button
          type="button"
          onClick={() => {
            setSettingsOpen((open) => !open);
          }}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          title="Settings"
          className={`${WEB_TABLE_TOP_CONTROL_CLASS} w-11`}
        >
          <SettingOutlined />
        </button>
        <div
          hidden={!settingsOpen}
          className="absolute right-0 top-[calc(100%+0.5rem)] w-52 rounded border border-emerald-700/60 bg-black/90 p-2 text-emerald-100 shadow-2xl"
          role="group"
          aria-label="Settings"
        >
          <button
            type="button"
            role="switch"
            aria-checked={compactLayout}
            onClick={() => {
              onCompactLayoutChange(!compactLayout);
            }}
            className="flex w-full items-center justify-between gap-4 rounded px-3 py-2 text-sm font-medium hover:bg-emerald-900/80"
          >
            <span>Compact table</span>
            <span
              aria-hidden="true"
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                compactLayout ? "bg-emerald-500" : "bg-slate-600"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  compactLayout ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={soundEnabled}
            onClick={() => {
              const next = !soundEnabled;
              setGameSoundEnabled(next);
              setSoundEnabled(next);
            }}
            className="flex w-full items-center justify-between gap-4 rounded px-3 py-2 text-sm font-medium hover:bg-emerald-900/80"
          >
            <span>Sound</span>
            <span
              aria-hidden="true"
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                soundEnabled ? "bg-emerald-500" : "bg-slate-600"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  soundEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </span>
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          if (quitRequested) {
            return;
          }
          setQuitRequested(true);
          try {
            onQuit();
          } catch (error) {
            setQuitRequested(false);
            throw error;
          }
        }}
        disabled={quitRequested}
        aria-busy={quitRequested}
        aria-label={quitLabel}
        title={quitLabel}
        data-state={quitRequested ? "requested" : "idle"}
        className={`${WEB_TABLE_TOP_CONTROL_CLASS} min-w-[5.5rem] px-4 data-[state=requested]:translate-y-px data-[state=requested]:scale-[0.96] data-[state=requested]:border-emerald-300/70 data-[state=requested]:bg-emerald-950 data-[state=requested]:text-white data-[state=requested]:shadow-inner disabled:cursor-wait disabled:opacity-100`}
      >
        {quitRequested ? (
          <LoadingOutlined spin aria-hidden="true" />
        ) : (
          <CloseOutlined aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
import { SettingOutlined } from "@ant-design/icons";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface WebTableTopControlsProps {
  compactLayout: boolean;
  onCompactLayoutChange: (compactLayout: boolean) => void;
  onQuit: () => void;
  quitLabel: string;
  children?: ReactNode;
}

export const WEB_TABLE_TOP_CONTROL_CLASS =
  "h-11 inline-flex items-center justify-center rounded bg-black/70 hover:bg-emerald-800 text-emerald-100 hover:text-white text-base font-medium transition-colors";

export function WebTableTopControls({
  compactLayout,
  onCompactLayoutChange,
  onQuit,
  quitLabel,
  children,
}: WebTableTopControlsProps): React.JSX.Element {
  const [parametersOpen, setParametersOpen] = useState(false);
  const parametersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!parametersOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !parametersRef.current?.contains(event.target)
      ) {
        setParametersOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setParametersOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [parametersOpen]);

  return (
    <div className="pointer-events-auto absolute right-2 top-2 z-[130] flex items-center gap-2">
      {children}
      <div ref={parametersRef} className="relative">
        <button
          type="button"
          onClick={() => {
            setParametersOpen((open) => !open);
          }}
          aria-label="Table parameters"
          aria-expanded={parametersOpen}
          title="Table parameters"
          className={`${WEB_TABLE_TOP_CONTROL_CLASS} w-11`}
        >
          <SettingOutlined />
        </button>
        <div
          hidden={!parametersOpen}
          className="absolute right-0 top-[calc(100%+0.5rem)] w-52 rounded border border-emerald-700/60 bg-black/90 p-2 text-emerald-100 shadow-2xl"
          role="group"
          aria-label="Table parameters"
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
        </div>
      </div>
      <button
        type="button"
        onClick={onQuit}
        aria-label={quitLabel}
        title={quitLabel}
        className={`${WEB_TABLE_TOP_CONTROL_CLASS} min-w-[5.5rem] px-4`}
        style={{ backgroundColor: "rgba(0, 0, 0, 0.7)", color: "#d1fae5" }}
      >
        ✕
      </button>
    </div>
  );
}
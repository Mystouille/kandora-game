import { useState } from "react";
import { Button, ConfigProvider, Tooltip, message, theme } from "antd";
import {
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  FontSizeOutlined,
  HighlightOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { Stroke } from "~/game/replay/reviewDrawing";
import { useLocale } from "~/contexts/LocaleContext";
import { FixedTileSetProvider } from "~/contexts/TileSetContext";
import { TileSetName } from "~/components/mahjong/handLayout";
import { RichTextEditor } from "~/components/editor/RichTextEditor";

/**
 * In-progress edits the user has typed/drawn for the current event
 * but not yet submitted. Discarded automatically when the playhead
 * moves to a new event (see `replay.tsx`).
 */
export interface ReviewDraft {
  mode: "text" | "pen" | null;
  text: string;
  strokes: Stroke[];
}

interface ReplayReviewCartridgeProps {
  /** Whether the current user can edit this review (owner check). */
  canEdit: boolean;
  /** Saved edit for the current event (from the server). */
  savedText: string;
  savedHasDrawing: boolean;
  /**
   * Saved strokes for the current event (decoded). When the user
   * enters pen mode the cartridge seeds the draft with these so
   * they can add to / modify the existing drawing instead of
   * starting from a blank canvas.
   */
  savedStrokes: Stroke[];
  /** Draft (in-progress) edit owned by the parent. */
  draft: ReviewDraft;
  onDraftChange: (next: ReviewDraft) => void;
  /** Submit the current draft to local pending state. */
  onSubmitText: (text: string) => Promise<void> | void;
  onSubmitDrawing: (strokes: Stroke[]) => Promise<void> | void;
  /** Clear all edits at the current event (text + drawing). */
  onErase: () => Promise<void> | void;
  /**
   * Number of edits awaiting publish (i.e. local-only changes
   * that have not yet been pushed to the server). Used to
   * gate the Discard button.
   */
  pendingCount: number;
  /**
   * `true` while the parent is pushing edits to the server. Used
   * to disable the Discard button mid-publish.
   */
  publishing: boolean;
  /** Drop all pending edits without pushing them. */
  onDiscardAll: () => void;
  /**
   * `true` when the review is locked to a seat that differs from
   * the currently focused seat. Adding new annotations is
   * forbidden in this state (text + freehand buttons are
   * disabled) but Clear remains available so the author can
   * still wrap up the review.
   */
  seatMismatch: boolean;
  /**
   * Display name of the seat the review is bound to. Used in the
   * tooltip that explains why the edit buttons are disabled.
   * Empty string when no seat is locked yet.
   */
  reviewSeatName: string;
}

/**
 * Floating "comment cartridge" anchored to the bottom-left of the
 * replay viewport. Lets the owner add a text note and/or a freehand
 * drawing on top of the current event, and produces a shareable URL
 * via the export modal.
 *
 * The cartridge is purely presentational about persistence: it
 * raises `onSubmitText` / `onSubmitDrawing` / `onErase` callbacks
 * and leaves the actual network calls to `replay.tsx`.
 */
export function ReplayReviewCartridge({
  canEdit,
  savedText,
  savedHasDrawing,
  savedStrokes,
  draft,
  onDraftChange,
  onSubmitText,
  onSubmitDrawing,
  onErase,
  pendingCount,
  publishing,
  onDiscardAll,
  seatMismatch,
  reviewSeatName,
}: ReplayReviewCartridgeProps) {
  const { t } = useLocale();
  const tr = t.review.cartridge;
  const [submitting, setSubmitting] = useState(false);

  if (!canEdit) {
    return null;
  }

  const inText = draft.mode === "text";
  const inPen = draft.mode === "pen";

  const startText = () => {
    onDraftChange({
      mode: "text",
      text: draft.text || savedText || "",
      strokes: draft.strokes,
    });
  };
  const startPen = () => {
    onDraftChange({
      mode: "pen",
      text: draft.text,
      // Seed with whatever is already saved for this event so the
      // user can add to / modify the existing drawing instead of
      // re-drawing from scratch. Clearing is done via the eraser.
      strokes: savedStrokes.slice(),
    });
  };
  const cancel = () => {
    onDraftChange({ mode: null, text: "", strokes: [] });
  };

  const submitText = async () => {
    setSubmitting(true);
    try {
      // Tiptap serializes an empty editor as `<p></p>`. Treat
      // the editor as empty when there's no visible text AND no
      // embedded media/tile nodes, so we don't persist phantom
      // annotations.
      const html = draft.text;
      const stripped = html.replace(/<[^>]+>/g, "").trim();
      const hasEmbeds = /<(img|mahjong-tile|mahjong-hand|video|iframe)\b/i.test(
        html
      );
      await onSubmitText(stripped.length === 0 && !hasEmbeds ? "" : html);
      onDraftChange({ mode: null, text: "", strokes: [] });
    } finally {
      setSubmitting(false);
    }
  };
  const submitDrawing = async () => {
    if (draft.strokes.length === 0) {
      message.info(tr.nothingToSave);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmitDrawing(draft.strokes);
      onDraftChange({ mode: null, text: "", strokes: [] });
    } finally {
      setSubmitting(false);
    }
  };
  const erase = async () => {
    setSubmitting(true);
    try {
      await onErase();
      onDraftChange({ mode: null, text: "", strokes: [] });
    } finally {
      setSubmitting(false);
    }
  };

  const hasSaved =
    (savedText && savedText.length > 0) || savedHasDrawing === true;

  const seatLockTooltip = seatMismatch
    ? tr.seatLockedTooltip.replace("{name}", reviewSeatName)
    : undefined;

  return (
    <>
      <div
        className="absolute bottom-2 left-2 z-50 flex flex-col items-start gap-2 pointer-events-auto"
        // Use inline backgroundColor for the cartridge body to defeat
        // any global anchor/button background resets in the portal.
        style={{}}
      >
        {/* Button row. The cartridge always has a dark
            translucent background, so we force the antd dark
            theme algorithm on its children. Otherwise `type='text'`
            buttons inherit the page-level theme and end up with
            near-black icons on the dark cartridge in light mode. */}
        <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
          <div
            className="flex items-center gap-2 rounded px-3 py-2 text-emerald-100 text-base"
            style={{
              // Tint the cartridge red when the review is locked to
              // a different seat, so the disabled edit buttons read
              // as "wrong seat" rather than "loading".
              backgroundColor: seatMismatch
                ? "rgba(127, 29, 29, 0.85)"
                : "rgba(0, 0, 0, 0.7)",
            }}
          >
            <Tooltip
              title={seatLockTooltip ?? tr.addTextTooltip}
              zIndex={10001}
            >
              <Button
                type={inText ? "primary" : "text"}
                size="middle"
                icon={<FontSizeOutlined />}
                onClick={inText ? cancel : startText}
                disabled={seatMismatch}
                aria-label={tr.addTextTooltip}
              >
                T
              </Button>
            </Tooltip>
            <Tooltip title={seatLockTooltip ?? tr.drawTooltip} zIndex={10001}>
              <Button
                type={inPen ? "primary" : "text"}
                size="middle"
                icon={<HighlightOutlined />}
                onClick={inPen ? cancel : startPen}
                disabled={seatMismatch}
                aria-label={tr.drawTooltip}
              />
            </Tooltip>
            <Tooltip title={tr.eraseTooltip} zIndex={10001}>
              <Button
                type="text"
                size="middle"
                icon={<ClearOutlined />}
                onClick={erase}
                disabled={!hasSaved || submitting}
                aria-label={tr.eraseTooltip}
              />
            </Tooltip>
            <div className="w-px h-7 bg-emerald-700/60 mx-1" />
            <Tooltip title={tr.discardAllTooltip} zIndex={10001}>
              <Button
                type="text"
                size="middle"
                icon={<DeleteOutlined />}
                onClick={onDiscardAll}
                disabled={pendingCount === 0 || submitting || publishing}
                aria-label={tr.discardAllTooltip}
              />
            </Tooltip>
          </div>
        </ConfigProvider>

        {/* Text input drawer: a full rich-text editor (same as
            the news article admin) so reviewers can drop in tile
            spans, mahjong hands, images, links, etc. The tile
            style is forced to Tenhou via `FixedTileSetProvider`
            so review annotations always render in a consistent
            style regardless of the viewer's preference. */}
        {inText && (
          <FixedTileSetProvider tileSet={TileSetName.Tenhou}>
            <div
              className="flex flex-col items-stretch gap-3 rounded p-3 bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700"
              style={{
                width: 820,
                maxWidth: "calc(100vw - 32px)",
              }}
            >
              <div
                className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 overflow-hidden"
                style={{ fontSize: 16 }}
              >
                <RichTextEditor
                  content={draft.text}
                  onChange={(html) => onDraftChange({ ...draft, text: html })}
                  // Replay page wrapper sits at z-[9999]; bump the
                  // toolbar pickers above it so they don't get
                  // hidden behind the canvas.
                  modalZIndex={10002}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button size="middle" onClick={cancel}>
                  {tr.cancel}
                </Button>
                <Button
                  type="primary"
                  size="middle"
                  icon={<SaveOutlined />}
                  loading={submitting}
                  onClick={submitText}
                >
                  {tr.save}
                </Button>
              </div>
            </div>
          </FixedTileSetProvider>
        )}

        {/* Drawing hint + submit. Same dark-cartridge background as
            the main button row, so force the antd dark algorithm to
            keep button colors readable regardless of the page theme. */}
        {inPen && (
          <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
            <div className="flex items-center gap-2 rounded bg-black/70 px-3 py-2 text-emerald-100 text-xs">
              <EditOutlined />
              <span>{tr.drawHint}</span>
              <Button
                type="primary"
                size="small"
                icon={<SaveOutlined />}
                loading={submitting}
                onClick={submitDrawing}
                disabled={draft.strokes.length === 0}
              >
                {tr.save}
              </Button>
              <Button
                type="text"
                size="small"
                onClick={() => onDraftChange({ ...draft, strokes: [] })}
                disabled={draft.strokes.length === 0}
              >
                {tr.undoAll}
              </Button>
              <Button type="text" size="small" onClick={cancel}>
                {tr.cancel}
              </Button>
            </div>
          </ConfigProvider>
        )}
      </div>
    </>
  );
}

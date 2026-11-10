import {
  StateEffect,
  StateField,
  type Extension,
  type EditorState,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { BlameLine } from "./blame";

export interface BlameExtensionOptions {
  /** Returns the cached blame map for a vault-relative markdown path. */
  getBlame: (filePath: string) => Promise<Map<number, BlameLine> | null>;
  /** Formats one blame entry for the ghost text. */
  format: (entry: BlameLine) => string;
  /** Delay after the last cursor movement before querying blame. */
  debounceMs?: number;
}

interface BlamePayload {
  line: number;
  /** Formatted ghost text, or null when the line has no attribution. */
  text: string | null;
}

/** Blame rendering is deferred by a macrotask when Git responds slowly. */
const SLOW_BLAME_MS = 50;

/** Wait for the cursor to rest before painting, avoiding typing flicker. */
const CURSOR_REST_MS = 180;

let blameEnabled = true;
const activeViews = new Set<BlameView>();

/**
 * Enables or disables inline blame for every open editor. Disabling clears
 * timers and decorations immediately so nothing keeps running in the
 * background; enabling schedules a fresh lookup.
 */
export function setBlameEnabled(enabled: boolean): void {
  if (blameEnabled === enabled) return;
  blameEnabled = enabled;
  for (const view of activeViews) view.setEnabled(enabled);
}

/**
 * Tells every open editor that a file was saved or changed on disk. Views
 * re-query blame; the cache decides whether a subprocess is actually needed.
 */
export function notifyBlameChanged(): void {
  if (!blameEnabled) return;
  for (const view of activeViews) view.refreshFromDisk();
}

/**
 * Releases every editor timer, pending lookup, and widget before the plugin
 * unloads. Editor views also remove themselves from the registry on destroy.
 */
export function disposeBlameExtension(): void {
  blameEnabled = false;
  for (const view of activeViews) view.setEnabled(false);
  activeViews.clear();
}

const setBlame = StateEffect.define<BlamePayload | null>();

/** Muted end-of-line label for the active line. */
class BlameWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: BlameWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "veloxgit-blame";
    el.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "veloxgit-blame-text";
    text.textContent = this.text;
    el.appendChild(text);

    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Holds the active-line highlight and at most one blame widget. */
const blameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);

    for (const effect of tr.effects) {
      if (!effect.is(setBlame)) continue;

      if (!effect.value) {
        next = Decoration.none;
        continue;
      }

      const lineNumber = Math.min(
        Math.max(1, effect.value.line),
        tr.state.doc.lines,
      );
      const line = tr.state.doc.line(lineNumber);
      const marks = [
        Decoration.line({ attributes: { class: "veloxgit-active-line" } }).range(
          line.from,
        ),
      ];

      if (effect.value.text !== null) {
        marks.push(
          Decoration.widget({
            widget: new BlameWidget(effect.value.text),
            side: 1,
          }).range(line.to),
        );
      }

      next = Decoration.set(marks, true);
    }

    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The markdown file attached to this specific editor view, if any. */
function filePathFor(state: EditorState): string | null {
  const info = state.field(editorInfoField, false);
  const file = info?.file;
  return file && file.extension === "md" ? file.path : null;
}

class BlameView {
  private timer: number | null = null;
  private requestId = 0;
  private painted: BlamePayload | null = null;
  private enabled = blameEnabled;
  private visibilityFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private contentWidth = 0;

  constructor(
    private readonly view: EditorView,
    private readonly options: BlameExtensionOptions,
  ) {
    activeViews.add(this);

    // A panel or sidebar resize changes how much room the label has.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (width === this.contentWidth) return;
        this.contentWidth = width;
        if (this.enabled && this.painted?.text) this.scheduleVisibility();
      });
      this.resizeObserver.observe(view.contentDOM);
    }

    if (this.enabled) this.schedule();
  }

  /** Called by `setBlameEnabled` when the plugin setting changes. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (enabled) {
      this.schedule();
      return;
    }

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.cancelVisibility();
    // Invalidate any in-flight request and hide the current annotation.
    this.requestId++;
    this.paint(null);
  }

  /** Called after a save or external disk change for this vault. */
  refreshFromDisk(): void {
    if (this.enabled) this.schedule();
  }

  update(update: ViewUpdate): void {
    // Blame only follows the cursor or the attached file. Pure typing does
    // not repaint: the cached annotation stays mapped by CodeMirror, and
    // saves refresh every view through `notifyBlameChanged()`.
    const fileChanged =
      filePathFor(update.startState) !== filePathFor(update.state);

    if (
      this.enabled &&
      (fileChanged || update.selectionSet || update.focusChanged)
    ) {
      this.schedule();
      return;
    }

    // Scrolled-in lines need a fresh overflow measurement.
    if (this.enabled && this.painted?.text && update.viewportChanged) {
      this.scheduleVisibility();
    }
  }

  destroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.cancelVisibility();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    activeViews.delete(this);
    this.requestId++;
  }

  private schedule(): void {
    if (!this.enabled) return;
    if (this.timer !== null) window.clearTimeout(this.timer);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.options.debounceMs ?? CURSOR_REST_MS);
  }

  private async refresh(): Promise<void> {
    if (!this.enabled) return;

    const request = ++this.requestId;
    const path = filePathFor(this.view.state);

    if (!path) {
      this.paint(null);
      return;
    }

    const lineAtStart = this.currentLine();
    const started = performance.now();
    let entry: BlameLine | undefined;

    try {
      const blame = await this.options.getBlame(path);
      entry = blame?.get(lineAtStart);
    } catch {
      // Untracked files and repos without history have no blame; the
      // annotation is simply omitted.
      entry = undefined;
    }

    // A newer request, disable, file switch, or cursor move wins.
    if (request !== this.requestId || !this.enabled) return;
    if (filePathFor(this.view.state) !== path) return;
    if (this.currentLine() !== lineAtStart) {
      this.schedule();
      return;
    }

    // Slow blame runs yield one macrotask so rendering never competes with
    // the subprocess result on the same frame.
    if (performance.now() - started > SLOW_BLAME_MS) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (request !== this.requestId || !this.enabled) return;
    }

    // Keep the active-line highlight even when the file has no blame yet.
    this.paint({
      line: lineAtStart,
      text: entry ? this.options.format(entry) : null,
    });
  }

  private currentLine(): number {
    const { state } = this.view;
    return state.doc.lineAt(state.selection.main.head).number;
  }

  private paint(value: BlamePayload | null): void {
    if (value === null && this.painted === null) return;
    if (
      value !== null &&
      this.painted !== null &&
      value.line === this.painted.line &&
      value.text === this.painted.text
    ) {
      return;
    }

    this.painted = value;
    this.view.dispatch({ effects: setBlame.of(value) });

    if (value?.text) this.scheduleVisibility();
    else this.cancelVisibility();
  }

  private cancelVisibility(): void {
    if (this.visibilityFrame === null) return;
    window.cancelAnimationFrame(this.visibilityFrame);
    this.visibilityFrame = null;
  }

  private scheduleVisibility(): void {
    if (this.visibilityFrame !== null) return;
    this.visibilityFrame = window.requestAnimationFrame(() => {
      this.visibilityFrame = null;
      this.syncVisibility();
    });
  }

  /**
   * Hides the ghost text when the note's own text reaches the label or the
   * line wraps, so dense paragraphs stay unobstructed. Runs once per paint
   * frame on the active line only; never while typing.
   */
  private syncVisibility(): void {
    if (!this.enabled || !this.painted?.text) return;

    const lineEl = this.view.contentDOM.querySelector<HTMLElement>(
      ".cm-line.veloxgit-active-line",
    );
    const blameEl = lineEl?.querySelector<HTMLElement>(".veloxgit-blame");
    if (!lineEl || !blameEl) return;

    const lineRect = lineEl.getBoundingClientRect();
    if (lineRect.width === 0) return;

    // Measure the label at full size; only its display state changes.
    blameEl.classList.remove("veloxgit-blame-hidden");
    const labelLeft = blameEl.getBoundingClientRect().left - lineRect.left;
    const limit = labelLeft - 8;

    let textRight = 0;
    let firstTop = Number.NaN;
    let wrapped = false;
    const range = document.createRange();
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (blameEl.contains(node)) continue;

      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (Number.isNaN(firstTop)) firstTop = rect.top;
        else if (Math.abs(rect.top - firstTop) > 2) wrapped = true;
        if (rect.right - lineRect.left > textRight) {
          textRight = rect.right - lineRect.left;
        }
      }
    }

    blameEl.classList.toggle(
      "veloxgit-blame-hidden",
      wrapped || textRight > limit,
    );
  }
}

/** CodeMirror extension that renders the active line's blame ghost text. */
export function createBlameExtension(
  options: BlameExtensionOptions,
): Extension {
  return [
    blameField,
    ViewPlugin.fromClass(
      class extends BlameView {
        constructor(view: EditorView) {
          super(view, options);
        }
      },
    ),
  ];
}

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
  text: string;
}

/** Blame rendering is deferred by a macrotask when Git responds slowly. */
const SLOW_BLAME_MS = 50;

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
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Holds the single widget decoration; replaced through `setBlame`. */
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
      next = Decoration.set([
        Decoration.widget({
          widget: new BlameWidget(effect.value.text),
          side: 1,
        }).range(line.to),
      ]);
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

  constructor(
    private readonly view: EditorView,
    private readonly options: BlameExtensionOptions,
  ) {
    activeViews.add(this);
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
    // Invalidate any in-flight request and hide the current annotation.
    this.requestId++;
    this.paint(null);
  }

  /** Called after a save or external disk change for this vault. */
  refreshFromDisk(): void {
    if (this.enabled) this.schedule();
  }

  update(update: ViewUpdate): void {
    // Typing never invalidates the cache; saved files refresh via
    // `notifyBlameChanged()`, so normal writing stays subprocess-free.
    if (
      this.enabled &&
      (update.docChanged || update.selectionSet || update.focusChanged)
    ) {
      this.schedule();
    }
  }

  destroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    activeViews.delete(this);
    this.requestId++;
  }

  private schedule(): void {
    if (!this.enabled) return;
    if (this.timer !== null) window.clearTimeout(this.timer);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.options.debounceMs ?? 150);
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
    } catch (error) {
      console.debug("[VeloxGit] blame lookup failed", error);
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

    this.paint(
      entry ? { line: lineAtStart, text: this.options.format(entry) } : null,
    );
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

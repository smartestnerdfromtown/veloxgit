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
  /** Drops cached blame when the document text changes. */
  invalidate: (filePath: string) => void;
  /** Formats one blame entry for the ghost text. */
  format: (entry: BlameLine) => string;
  /** Delay after the last cursor movement before querying blame. */
  debounceMs?: number;
}

interface BlamePayload {
  line: number;
  text: string;
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

  constructor(
    private readonly view: EditorView,
    private readonly options: BlameExtensionOptions,
  ) {
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      const path = filePathFor(update.startState) ?? filePathFor(update.state);
      if (path) this.options.invalidate(path);
    }

    if (update.docChanged || update.selectionSet || update.focusChanged) {
      this.schedule();
    }
  }

  destroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.requestId++;
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.options.debounceMs ?? 150);
  }

  private async refresh(): Promise<void> {
    const request = ++this.requestId;
    const path = filePathFor(this.view.state);

    if (!path) {
      this.paint(null);
      return;
    }

    const lineAtStart = this.currentLine();
    let entry: BlameLine | undefined;

    try {
      const blame = await this.options.getBlame(path);
      entry = blame?.get(lineAtStart);
    } catch (error) {
      console.debug("[VeloxGit] blame lookup failed", error);
    }

    // A newer request, file switch, or cursor move wins.
    if (request !== this.requestId) return;
    if (filePathFor(this.view.state) !== path) return;
    if (this.currentLine() !== lineAtStart) {
      this.schedule();
      return;
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

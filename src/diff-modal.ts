import { App, Modal } from "obsidian";

const ADDED_BG = "rgba(46, 160, 67, 0.15)";
const REMOVED_BG = "rgba(248, 81, 73, 0.15)";
const META_BG = "rgba(127, 127, 127, 0.08)";

/**
 * Minimal read-only diff viewer. Lines are plain DOM nodes, classified by
 * their Git prefix; no Markdown or syntax highlighting pipeline involved.
 */
export class DiffModal extends Modal {
  private bodyEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly filePath: string,
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.filePath);
    this.titleEl.title = this.filePath;
    this.modalEl.style.width = "min(900px, 92vw)";

    const body = this.contentEl.createDiv();
    body.style.maxHeight = "65vh";
    body.style.overflow = "auto";
    body.style.fontFamily = "var(--font-monospace)";
    body.style.fontSize = "12px";
    body.style.lineHeight = "1.5";
    body.style.whiteSpace = "pre";
    body.style.tabSize = "2";
    body.style.background = "var(--background-primary-alt)";
    body.style.padding = "8px";
    body.style.borderRadius = "4px";

    this.bodyEl = body;
    this.showMessage("Loading diff…");
  }

  setDiff(text: string): void {
    const body = this.bodyEl;
    if (!body) return;

    body.empty();

    if (text.trim().length === 0) {
      this.showMessage("No textual changes to display.");
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const line of text.split("\n")) {
      const lineEl = document.createElement("div");
      lineEl.textContent = line;
      lineEl.style.minHeight = "1.5em";
      // Off-screen lines skip layout/paint without truncating the diff.
      lineEl.style.setProperty("content-visibility", "auto");
      lineEl.style.setProperty("contain-intrinsic-size", "18px");
      styleLine(lineEl, line);
      fragment.appendChild(lineEl);
    }

    body.appendChild(fragment);
  }

  setError(message: string): void {
    const body = this.bodyEl;
    if (!body) return;

    body.empty();
    const errorEl = body.createDiv({ text: message });
    errorEl.style.color = "var(--text-error)";
  }

  onClose(): void {
    this.bodyEl = null;
    this.contentEl.empty();
    this.onClosed?.();
  }

  private showMessage(message: string): void {
    const body = this.bodyEl;
    if (!body) return;

    body.empty();
    const messageEl = body.createDiv({ text: message });
    messageEl.style.color = "var(--text-muted)";
  }
}

function styleLine(element: HTMLElement, line: string): void {
  // File headers ("+++"/"---") must be checked before +/- patches.
  if (line.startsWith("+++") || line.startsWith("---")) {
    element.style.color = "var(--text-muted)";
    element.style.background = META_BG;
    return;
  }
  if (line.startsWith("diff ") || line.startsWith("index ")) {
    element.style.color = "var(--text-muted)";
    return;
  }
  if (line.startsWith("@@")) {
    element.style.color = "var(--text-accent)";
    return;
  }
  if (line.startsWith("+")) {
    element.style.color = "var(--text-success)";
    element.style.background = ADDED_BG;
    return;
  }
  if (line.startsWith("-")) {
    element.style.color = "var(--text-error)";
    element.style.background = REMOVED_BG;
    return;
  }
  if (line.startsWith("\\ No newline")) {
    element.style.color = "var(--text-muted)";
  }
}

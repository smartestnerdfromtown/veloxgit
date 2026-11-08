import { App, Modal } from "obsidian";
import { describeError } from "./error-utils";

/**
 * Minimal branch switcher: lists local branches and offers a create field.
 * The actual Git work is delegated to the plugin's async action.
 */
export class BranchModal extends Modal {
  private busy = false;
  private inputEl: HTMLInputElement | null = null;
  private errorEl: HTMLElement | null = null;
  private controls: Array<HTMLButtonElement | HTMLInputElement> = [];

  constructor(
    app: App,
    private readonly current: string | null,
    private readonly branches: string[],
    private readonly onSelect: (branch: string, create: boolean) => Promise<void>,
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Switch branch");

    const currentEl = this.contentEl.createEl("p", {
      text: `Current: ${this.current ?? "detached HEAD"}`,
    });
    currentEl.style.marginTop = "0";

    const listLabel = this.contentEl.createDiv({ text: "Existing branches" });
    listLabel.style.fontSize = "12px";
    listLabel.style.fontWeight = "600";
    listLabel.style.textTransform = "uppercase";
    listLabel.style.letterSpacing = "0.04em";
    listLabel.style.opacity = "0.8";
    listLabel.style.marginBottom = "4px";

    const list = this.contentEl.createDiv();
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.maxHeight = "35vh";
    list.style.overflowY = "auto";
    list.style.marginBottom = "12px";

    if (this.branches.length === 0) {
      const empty = list.createDiv({ text: "No local branches yet." });
      empty.style.fontSize = "12px";
      empty.style.opacity = "0.6";
    }

    for (const branch of this.branches) {
      const isCurrent = branch === this.current;
      const row = list.createDiv();
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";
      row.style.padding = "5px 6px";
      row.style.fontSize = "13px";
      row.style.borderRadius = "4px";

      const name = row.createSpan({ text: branch });
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";

      if (isCurrent) {
        const marker = row.createSpan({ text: "(current)" });
        marker.style.fontSize = "11px";
        marker.style.color = "var(--text-muted)";
        row.style.opacity = "0.7";
      } else {
        row.style.cursor = "pointer";
        row.addEventListener("click", () => void this.runAction(branch, false));
        row.addEventListener("mouseenter", () => {
          row.style.background = "var(--background-modifier-hover)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "";
        });
      }
    }

    const createLabel = this.contentEl.createDiv({ text: "Create branch" });
    createLabel.style.fontSize = "12px";
    createLabel.style.fontWeight = "600";
    createLabel.style.textTransform = "uppercase";
    createLabel.style.letterSpacing = "0.04em";
    createLabel.style.opacity = "0.8";
    createLabel.style.marginBottom = "4px";

    const createRow = this.contentEl.createDiv();
    createRow.style.display = "flex";
    createRow.style.gap = "8px";

    const input = createRow.createEl("input", { type: "text" });
    input.placeholder = "new-branch-name";
    input.autocomplete = "off";
    input.style.flex = "1";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.runAction(input.value, true);
      }
    });
    this.inputEl = input;

    const createButton = createRow.createEl("button", { text: "Create & switch" });
    createButton.addEventListener("click", () => void this.runAction(input.value, true));
    this.controls.push(input, createButton);

    this.errorEl = this.contentEl.createDiv();
    this.errorEl.style.marginTop = "8px";
    this.errorEl.style.fontSize = "12px";
    this.errorEl.style.color = "var(--text-error)";
    this.errorEl.style.whiteSpace = "pre-wrap";

    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  onClose(): void {
    this.inputEl = null;
    this.errorEl = null;
    this.controls = [];
    this.contentEl.empty();
    this.onClosed?.();
  }

  private async runAction(branch: string, create: boolean): Promise<void> {
    if (this.busy) return;

    const name = branch.trim();
    if (name.length === 0) {
      this.setError("Enter a branch name.");
      return;
    }
    if (!create && name === this.current) {
      this.close();
      return;
    }

    this.busy = true;
    this.setError("");
    this.setDisabled(true);

    try {
      await this.onSelect(name, create);
      this.close();
    } catch (error) {
      this.setError(describeError(error, 300));
    } finally {
      this.busy = false;
      this.setDisabled(false);
    }
  }

  private setDisabled(disabled: boolean): void {
    for (const control of this.controls) {
      control.disabled = disabled;
    }
  }

  private setError(message: string): void {
    this.errorEl?.setText(message);
  }
}

import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import { describeError } from "./error-utils";

export function defaultCommitMessage(now = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `Vault backup: ${date} ${time}`;
}

/**
 * Commit message prompt. Prefilled with a timestamp so pressing Enter
 * commits immediately; an empty field also falls back to the timestamp.
 */
export class CommitModal extends Modal {
  private message = defaultCommitMessage();
  private messageInput: TextComponent | null = null;
  private submitting = false;

  constructor(
    app: App,
    private readonly onSubmit: (message: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Commit changes");

    this.contentEl.createEl("p", {
      text: "Commits the currently staged changes. Leave the message empty to use the timestamp.",
    });

    new Setting(this.contentEl)
      .setName("Message")
      .addText((text) => {
        this.messageInput = text;
        text
          .setValue(this.message)
          .onChange((value) => {
            this.message = value;
          });
        text.inputEl.autocomplete = "off";
      });

    const actions = this.contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "12px";

    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    const commitButton = actions.createEl("button", {
      text: "Commit",
      cls: "mod-cta",
    });
    commitButton.addEventListener("click", () => void this.submit(commitButton));

    this.contentEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.submit(commitButton);
      }
    });

    window.setTimeout(() => {
      this.messageInput?.inputEl.focus();
      this.messageInput?.inputEl.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(button: HTMLButtonElement): Promise<void> {
    if (this.submitting) return;

    const message = this.message.trim() || defaultCommitMessage();

    this.submitting = true;
    button.disabled = true;
    button.setText("Committing...");

    try {
      await this.onSubmit(message);
      this.close();
    } catch (error) {
      console.error("[VeloxGit] Commit failed", error);
      new Notice(`VeloxGit: commit failed.\n${describeError(error)}`, 8000);
      this.submitting = false;
      button.disabled = false;
      button.setText("Commit");
    }
  }
}

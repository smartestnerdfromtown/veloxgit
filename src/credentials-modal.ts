import { App, Modal, Notice, Setting, TextComponent } from "obsidian";

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Minimal modal used only when this repository has no effective
 * user.name / user.email. Values are written to the local repo config.
 */
export class CredentialsModal extends Modal {
  private name: string;
  private email: string;
  private nameInput: TextComponent | null = null;
  private submitting = false;

  constructor(
    app: App,
    initial: GitIdentity,
    private readonly onSubmit: (identity: GitIdentity) => Promise<void>,
  ) {
    super(app);
    this.name = initial.name;
    this.email = initial.email;
  }

  onOpen(): void {
    this.titleEl.setText("Git identity");

    this.contentEl.createEl("p", {
      text: "VeloxGit needs an author name and email for this vault's repository. They are stored with git config --local.",
    });

    new Setting(this.contentEl)
      .setName("Name")
      .setDesc("Used as the commit author.")
      .addText((text) => {
        this.nameInput = text;
        text
          .setPlaceholder("Jane Doe")
          .setValue(this.name)
          .onChange((value) => {
            this.name = value;
          });
        text.inputEl.autocomplete = "off";
      });

    new Setting(this.contentEl)
      .setName("Email")
      .setDesc("Used as the commit author email.")
      .addText((text) => {
        text
          .setPlaceholder("you@example.com")
          .setValue(this.email)
          .onChange((value) => {
            this.email = value;
          });
        text.inputEl.type = "email";
        text.inputEl.autocomplete = "off";
      });

    const actions = this.contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";
    actions.style.marginTop = "12px";

    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    const saveButton = actions.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    saveButton.addEventListener("click", () => void this.submit(saveButton));

    this.contentEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.submit(saveButton);
      }
    });

    window.setTimeout(() => this.nameInput?.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(button: HTMLButtonElement): Promise<void> {
    if (this.submitting) return;

    const name = this.name.trim();
    const email = this.email.trim();

    if (!name || !email) {
      new Notice("VeloxGit: enter both a name and an email.");
      return;
    }

    this.submitting = true;
    button.disabled = true;
    button.setText("Saving...");

    try {
      await this.onSubmit({ name, email });
      this.close();
    } catch (error) {
      console.error("[VeloxGit] Failed to save Git identity", error);
      new Notice("VeloxGit: could not save Git identity. See console for details.");
      this.submitting = false;
      button.disabled = false;
      button.setText("Save");
    }
  }
}

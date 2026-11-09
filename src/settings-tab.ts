import { App, PluginSettingTab, Setting } from "obsidian";
import type VeloxGitPlugin from "../main";

/**
 * Settings UI for background automation. Values are persisted immediately;
 * the timer engine is re-configured after every save.
 */
export class VeloxGitSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VeloxGitPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Background automation").setHeading();

    new Setting(containerEl)
      .setName("Enable auto-save")
      .setDesc("Run the background auto-save timer at a fixed interval.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableAutoSave).onChange(async (value) => {
          this.plugin.settings.enableAutoSave = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-save interval")
      .setDesc("Minutes between background auto-save runs. Minimum 1 minute.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        text.inputEl.style.width = "6em";
        text.setValue(String(this.plugin.settings.autoSaveInterval));

        text.onChange((value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed)) return;

          const minutes = Math.max(1, parsed);
          if (minutes === this.plugin.settings.autoSaveInterval) return;

          this.plugin.settings.autoSaveInterval = minutes;
          void this.plugin.saveSettings();
        });

        // Restore a valid value if the field is left empty or invalid.
        text.inputEl.addEventListener("blur", () => {
          text.setValue(String(this.plugin.settings.autoSaveInterval));
        });
      });

    new Setting(containerEl)
      .setName("Sync after inactivity")
      .setDesc("Run a sync once file activity has been quiet for 30 seconds.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
          this.plugin.settings.syncOnSave = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Pull remote changes when Obsidian starts.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Sync when leaving window")
      .setDesc("Run a background sync when Obsidian loses focus or is minimized.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncOnExitOrBlur).onChange(async (value) => {
          this.plugin.settings.syncOnExitOrBlur = value;
          await this.plugin.saveSettings();
        });
      });
  }
}

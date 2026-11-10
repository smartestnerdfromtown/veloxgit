import { App, PluginSettingTab, Setting } from "obsidian";
import type VeloxGitPlugin from "../main";

/**
 * Settings UI for background automation and inline blame. Values are
 * persisted immediately; live subsystems are re-configured after every save.
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

    new Setting(containerEl).setName("Inline blame").setHeading();

    new Setting(containerEl)
      .setName("Enable inline blame")
      .setDesc("Show author, relative time, and commit message at the end of the active line.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableInlineBlame).onChange(async (value) => {
          this.plugin.settings.enableInlineBlame = value;
          await this.plugin.saveSettings();
        });
      });

    this.addColorSetting(
      containerEl,
      "Blame text color",
      "Leave the default to follow the current theme.",
      "blameTextColor",
      "var(--text-muted)",
    );

    this.addColorSetting(
      containerEl,
      "Active line highlight",
      "Background color of the line that owns the blame. Leave the default to follow the theme.",
      "blameHighlightColor",
      "var(--background-secondary-alt)",
    );

    const currentSize = this.plugin.settings.blameFontSize;
    const sizes = BLAME_TEXT_SIZES.includes(currentSize)
      ? BLAME_TEXT_SIZES
      : [...BLAME_TEXT_SIZES, currentSize].sort((a, b) => a - b);

    new Setting(containerEl)
      .setName("Blame text size")
      .setDesc("Ghost text size in pixels.")
      .addDropdown((dropdown) => {
        for (const size of sizes) dropdown.addOption(String(size), `${size} px`);
        dropdown.setValue(String(currentSize)).onChange(async (value) => {
          this.plugin.settings.blameFontSize = Number(value);
          await this.plugin.saveSettings();
        });
      });
  }

  /** Color picker plus a reset button that restores the theme color. */
  private addColorSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: "blameTextColor" | "blameHighlightColor",
    token: string,
  ): void {
    const current = this.plugin.settings[key] || resolveThemeColor(token);

    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addColorPicker((picker) => {
        picker.setValue(current).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveSettings();
        });
      })
      .addExtraButton((button) => {
        button
          .setIcon("rotate-ccw")
          .setTooltip("Use theme color")
          .onClick(async () => {
            this.plugin.settings[key] = "";
            await this.plugin.saveSettings();
            this.display();
          });
      });
  }
}

/** Sizes offered in the blame text dropdown. */
const BLAME_TEXT_SIZES = [10, 11, 12, 13, 14, 16];

/** Resolves a theme token to a hex color for the picker's initial value. */
function resolveThemeColor(token: string): string {
  const probe = document.createElement("div");
  probe.style.color = token;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = window.getComputedStyle(probe).color;
  probe.remove();

  const channels = computed.match(/\d+(\.\d+)?/g);
  if (!channels || channels.length < 3) return "#888888";

  return `#${channels
    .slice(0, 3)
    .map((value) => Math.round(Number(value)).toString(16).padStart(2, "0"))
    .join("")}`;
}

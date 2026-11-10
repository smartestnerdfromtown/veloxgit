export interface VeloxGitSettings {
  /** Run the background auto-save timer. */
  enableAutoSave: boolean;
  /** Auto-save interval in minutes (minimum 1). */
  autoSaveInterval: number;
  /** Run a sync after a period of file inactivity. */
  syncOnSave: boolean;
  /** Pull remote changes once when Obsidian starts. */
  syncOnStartup: boolean;
  /** Sync when the window loses focus or the document becomes hidden. */
  syncOnExitOrBlur: boolean;
  /** Render inline Git blame ghost text in the editor. */
  enableInlineBlame: boolean;
  /** Blame text color (CSS color); empty follows the theme. */
  blameTextColor: string;
  /** Active-line highlight color (CSS color); empty follows the theme. */
  blameHighlightColor: string;
  /** Blame ghost text size in pixels. */
  blameFontSize: number;
}

export const DEFAULT_SETTINGS: VeloxGitSettings = {
  enableAutoSave: false,
  autoSaveInterval: 15,
  syncOnSave: false,
  syncOnStartup: false,
  syncOnExitOrBlur: true,
  enableInlineBlame: true,
  blameTextColor: "",
  blameHighlightColor: "",
  blameFontSize: 12,
};

/** Coerces persisted data into a valid settings object. */
export function normalizeSettings(data: unknown): VeloxGitSettings {
  const stored = (data ?? {}) as Partial<Record<keyof VeloxGitSettings, unknown>>;
  const rawInterval = stored.autoSaveInterval;
  // Missing values fall back to the default; present-but-invalid values are
  // clamped so the timer can never be faster than one minute.
  const interval =
    rawInterval === null || rawInterval === undefined || rawInterval === ""
      ? DEFAULT_SETTINGS.autoSaveInterval
      : Number(rawInterval);

  const rawSize = stored.blameFontSize;
  const parsedSize =
    rawSize === null || rawSize === undefined || rawSize === ""
      ? DEFAULT_SETTINGS.blameFontSize
      : Number(rawSize);
  const size = Number.isFinite(parsedSize)
    ? Math.min(24, Math.max(8, Math.round(parsedSize)))
    : DEFAULT_SETTINGS.blameFontSize;

  return {
    enableAutoSave: Boolean(stored.enableAutoSave),
    autoSaveInterval: Number.isFinite(interval)
      ? Math.max(1, Math.floor(interval))
      : DEFAULT_SETTINGS.autoSaveInterval,
    syncOnSave: Boolean(stored.syncOnSave),
    syncOnStartup: Boolean(stored.syncOnStartup),
    syncOnExitOrBlur:
      stored.syncOnExitOrBlur === undefined
        ? DEFAULT_SETTINGS.syncOnExitOrBlur
        : Boolean(stored.syncOnExitOrBlur),
    enableInlineBlame:
      stored.enableInlineBlame === undefined
        ? DEFAULT_SETTINGS.enableInlineBlame
        : Boolean(stored.enableInlineBlame),
    blameTextColor: colorOrEmpty(stored.blameTextColor),
    blameHighlightColor: colorOrEmpty(stored.blameHighlightColor),
    blameFontSize: size,
  };
}

/** Keeps only non-empty string colors; anything else means "theme default". */
function colorOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

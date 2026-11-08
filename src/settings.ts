export interface VeloxGitSettings {
  /** Run the background auto-save timer. */
  enableAutoSave: boolean;
  /** Auto-save interval in minutes (minimum 1). */
  autoSaveInterval: number;
  /** Run a sync after a period of file inactivity. */
  syncOnSave: boolean;
  /** Pull remote changes once when Obsidian starts. */
  syncOnStartup: boolean;
}

export const DEFAULT_SETTINGS: VeloxGitSettings = {
  enableAutoSave: false,
  autoSaveInterval: 15,
  syncOnSave: false,
  syncOnStartup: false,
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

  return {
    enableAutoSave: Boolean(stored.enableAutoSave),
    autoSaveInterval: Number.isFinite(interval)
      ? Math.max(1, Math.floor(interval))
      : DEFAULT_SETTINGS.autoSaveInterval,
    syncOnSave: Boolean(stored.syncOnSave),
    syncOnStartup: Boolean(stored.syncOnStartup),
  };
}

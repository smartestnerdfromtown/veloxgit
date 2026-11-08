import type { VeloxGitSettings } from "./settings";

/**
 * Delay after the last activity before the inactivity sync fires. The vault
 * event listener that feeds `notifyActivity()` arrives in the next step.
 */
export const INACTIVITY_DELAY_MS = 30_000;

export interface AutoSyncCallbacks {
  /** Fired every `autoSaveInterval` minutes while auto-save is enabled. */
  onAutoSaveTick: () => void;
  /** Fired once after `INACTIVITY_DELAY_MS` without vault activity. */
  onInactivitySync: () => void;
}

/**
 * Owns every background timer. Callbacks are fire-and-forget so the
 * Electron UI thread is never blocked by scheduled work.
 */
export class AutoSyncEngine {
  private intervalId: number | null = null;
  private inactivityId: number | null = null;
  private settings: VeloxGitSettings;
  private stopped = true;

  constructor(
    settings: VeloxGitSettings,
    private readonly callbacks: AutoSyncCallbacks,
  ) {
    this.settings = settings;
  }

  start(): void {
    this.stopped = false;
    this.restartAutoSaveTimer();
  }

  updateSettings(settings: VeloxGitSettings): void {
    this.settings = settings;
    if (this.stopped) return;

    this.restartAutoSaveTimer();
    if (!settings.syncOnSave) {
      this.clearInactivityTimer();
    }
  }

  /**
   * Resets the inactivity countdown. Safe to call on every vault change.
   */
  notifyActivity(): void {
    if (this.stopped || !this.settings.syncOnSave) return;

    this.clearInactivityTimer();
    this.inactivityId = window.setTimeout(() => {
      this.inactivityId = null;
      if (this.stopped) return;
      this.invoke(this.callbacks.onInactivitySync);
    }, INACTIVITY_DELAY_MS);
  }

  /** Cancels every pending timer. Called from `onunload()`. */
  dispose(): void {
    this.stopped = true;
    this.clearAutoSaveTimer();
    this.clearInactivityTimer();
  }

  private restartAutoSaveTimer(): void {
    this.clearAutoSaveTimer();
    if (!this.settings.enableAutoSave) return;

    const minutes = Math.max(1, Math.floor(this.settings.autoSaveInterval));
    this.intervalId = window.setInterval(() => {
      if (this.stopped) return;
      this.invoke(this.callbacks.onAutoSaveTick);
    }, minutes * 60_000);
  }

  private clearAutoSaveTimer(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private clearInactivityTimer(): void {
    if (this.inactivityId !== null) {
      window.clearTimeout(this.inactivityId);
      this.inactivityId = null;
    }
  }

  /** A throwing callback must not break the timer loop. */
  private invoke(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error("[VeloxGit] background timer callback failed", error);
    }
  }
}

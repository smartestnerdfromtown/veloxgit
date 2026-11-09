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
  /** Fired when Obsidian loses focus or the document becomes hidden. */
  onWindowLeave: () => void;
}

/**
 * Owns every background timer and window-lifecycle listener. Callbacks are
 * fire-and-forget so the Electron UI thread is never blocked.
 */
export class AutoSyncEngine {
  private intervalId: number | null = null;
  private inactivityId: number | null = null;
  private settings: VeloxGitSettings;
  private stopped = true;
  private leaveListenersAttached = false;

  constructor(
    settings: VeloxGitSettings,
    private readonly callbacks: AutoSyncCallbacks,
  ) {
    this.settings = settings;
  }

  start(): void {
    if (!this.stopped) return;

    this.stopped = false;
    this.syncLeaveListeners();
    this.restartAutoSaveTimer();
  }

  updateSettings(settings: VeloxGitSettings): void {
    this.settings = settings;
    if (this.stopped) return;

    this.syncLeaveListeners();
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

  /** Cancels every pending timer and unregisters lifecycle listeners. */
  dispose(): void {
    this.stopped = true;
    this.detachLeaveListeners();
    this.clearAutoSaveTimer();
    this.clearInactivityTimer();
  }

  /** Attaches or detaches blur/visibility listeners from the current setting. */
  private syncLeaveListeners(): void {
    if (this.settings.syncOnExitOrBlur) {
      this.attachLeaveListeners();
    } else {
      this.detachLeaveListeners();
    }
  }

  private attachLeaveListeners(): void {
    if (this.leaveListenersAttached) return;

    window.addEventListener("blur", this.handleWindowBlur);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.leaveListenersAttached = true;
  }

  private detachLeaveListeners(): void {
    if (!this.leaveListenersAttached) return;

    window.removeEventListener("blur", this.handleWindowBlur);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.leaveListenersAttached = false;
  }

  /**
   * A `blur` on the window means focus definitively left the Obsidian window.
   * Checking `document.hasFocus()` here is unreliable because the focus state
   * is not updated yet while the event is being dispatched.
   */
  private readonly handleWindowBlur = (): void => {
    if (this.stopped) return;
    this.invoke(this.callbacks.onWindowLeave);
  };

  /** Only a transition to hidden counts; becoming visible must not sync. */
  private readonly handleVisibilityChange = (): void => {
    if (this.stopped || !document.hidden) return;
    this.invoke(this.callbacks.onWindowLeave);
  };

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

  /** A throwing callback must not break timers or lifecycle listeners. */
  private invoke(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error("[VeloxGit] background callback failed", error);
    }
  }
}

import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { AutoSyncEngine } from "./src/auto-sync-engine";
import { BranchModal } from "./src/branch-modal";
import { CommitModal } from "./src/commit-modal";
import { CredentialsModal, type GitIdentity } from "./src/credentials-modal";
import { DiffModal } from "./src/diff-modal";
import { describeError } from "./src/error-utils";
import { GitService, type FileChange, type GitEnvironment, type PullResult } from "./src/git-service";
import { isNetworkError, isOnline } from "./src/network";
import { PushRetryTimer } from "./src/push-retry";
import { DEFAULT_SETTINGS, normalizeSettings, type VeloxGitSettings } from "./src/settings";
import { VeloxGitSettingTab } from "./src/settings-tab";
import { VeloxGitView, VIEW_TYPE_VELOXGIT } from "./src/veloxgit-view";

/** Coalesces overlapping blur and visibility events into one leave sync. */
const LEAVE_SYNC_DELAY_MS = 400;

/**
 * VeloxGit - ultra-fast, minimalist Git client for Obsidian.
 *
 * Changed-files list in the sidebar; all Git work stays async.
 */
export default class VeloxGitPlugin extends Plugin {
  settings: VeloxGitSettings = { ...DEFAULT_SETTINGS };

  private git: GitService | null = null;
  private environment: GitEnvironment | null = null;
  private statusBarEl: HTMLElement | null = null;
  private syncIndicatorEl: HTMLElement | null = null;
  private syncStatusTimer: number | null = null;
  private identityModal: CredentialsModal | null = null;
  private commitModal: CommitModal | null = null;
  private diffModal: DiffModal | null = null;
  private branchModal: BranchModal | null = null;
  private autoSync: AutoSyncEngine | null = null;
  private view: VeloxGitView | null = null;
  private isGitBusy = false;
  private pendingPush = false;
  private leaveSyncTimer: number | null = null;
  private readonly pushRetry = new PushRetryTimer(() => {
    if (this.pendingPush) void this.silentSync();
  });

  onload(): void {
    // Status bar text doubles as a lightweight environment indicator.
    this.statusBarEl = this.addStatusBarItem();
    this.setStatus("VeloxGit");

    // Dedicated auto-sync indicator; hidden until a background sync runs.
    this.syncIndicatorEl = this.addStatusBarItem();
    this.syncIndicatorEl.style.display = "none";

    this.addCommand({
      id: "stage-all",
      name: "Stage all changes",
      callback: () => void this.stageAll(),
    });

    this.addCommand({
      id: "commit-changes",
      name: "Commit changes",
      callback: () => void this.promptForCommit(),
    });

    this.addCommand({
      id: "push-changes",
      name: "Push changes",
      callback: () => void this.push(),
    });

    this.addCommand({
      id: "pull-changes",
      name: "Pull changes",
      callback: () => void this.pull(),
    });

    this.addCommand({
      id: "open-panel",
      name: "Open VeloxGit panel",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "check-git-environment",
      name: "Check Git environment",
      callback: () => void this.checkGitEnvironment(),
    });

    this.addCommand({
      id: "set-git-identity",
      name: "Set Git identity",
      callback: () => void this.promptForIdentity(),
    });

    this.registerView(VIEW_TYPE_VELOXGIT, (leaf) => {
      const view = new VeloxGitView(leaf, {
        stageAll: () => void this.stageAll(),
        commit: () => void this.promptForCommit(),
        push: () => void this.push(),
        pull: () => void this.pull(),
        getStatus: () => (this.git ? this.git.getStatus() : Promise.resolve(null)),
        showDiff: (file) => void this.showDiff(file),
        showBranchPrompt: () => void this.showBranchPrompt(),
      });
      this.view = view;
      return view;
    });

    this.addRibbonIcon("git-branch", "VeloxGit: Open panel", () => {
      void this.activateView();
    });

    // Feed the inactivity debouncer. registerEvent() unregisters on unload.
    this.registerEvent(
      this.app.vault.on("modify", () => {
        this.autoSync?.notifyActivity();
      }),
    );

    // Reflect connectivity changes and retry queued pushes when back online.
    this.registerDomEvent(window, "offline", () => this.setOfflineStatus());
    this.registerDomEvent(window, "online", () => this.handleOnline());

    // Load settings first, then start Git checks and background timers.
    void this.bootstrap().catch((error) => {
      console.error("[VeloxGit] Initialization failed", error);
    });

    console.debug("[VeloxGit] loaded");
  }

  onunload(): void {
    // Cancel a pending window-leave sync before tearing anything else down.
    if (this.leaveSyncTimer !== null) {
      window.clearTimeout(this.leaveSyncTimer);
      this.leaveSyncTimer = null;
    }

    // Stop every background timer before tearing anything else down.
    this.autoSync?.dispose();
    this.autoSync = null;

    if (this.syncStatusTimer !== null) {
      window.clearTimeout(this.syncStatusTimer);
      this.syncStatusTimer = null;
    }
    this.syncIndicatorEl = null;
    this.isGitBusy = false;
    this.pendingPush = false;
    this.clearPushRetry();

    this.identityModal?.close();
    this.identityModal = null;
    this.commitModal?.close();
    this.commitModal = null;
    this.diffModal?.close();
    this.diffModal = null;
    this.branchModal?.close();
    this.branchModal = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_VELOXGIT);
    this.view = null;

    console.debug("[VeloxGit] unloaded");
  }

  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  private async bootstrap(): Promise<void> {
    await this.loadSettings();

    this.autoSync = new AutoSyncEngine(this.settings, {
      onAutoSaveTick: () => this.handleAutoSaveTick(),
      onInactivitySync: () => this.handleInactivitySync(),
      onWindowLeave: () => this.handleWindowLeave(),
    });
    this.autoSync.start();

    this.addSettingTab(new VeloxGitSettingTab(this.app, this));

    await this.initializeGit();

    if (
      this.settings.syncOnStartup &&
      this.environment?.available &&
      this.environment.isRepo
    ) {
      void this.silentSync(true);
    }
  }

  private async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.autoSync?.updateSettings(this.settings);
  }

  private handleAutoSaveTick(): void {
    void this.silentSync(true);
  }

  private handleInactivitySync(): void {
    void this.silentSync(false);
  }

  /**
   * App switch or minimize. The short debounce coalesces overlapping blur and
   * visibility events, and an empty commit guarantees the marker appears in
   * `git log` even when nothing changed.
   */
  private handleWindowLeave(): void {
    if (this.leaveSyncTimer !== null) window.clearTimeout(this.leaveSyncTimer);

    this.leaveSyncTimer = window.setTimeout(() => {
      this.leaveSyncTimer = null;
      const message = `Window left at ${formatTimestamp(undefined, true)}`;
      console.debug(`[VeloxGit] ${message}`);
      void this.silentSync(false, message, true);
    }, LEAVE_SYNC_DELAY_MS);
  }

  /**
   * Background sync pipeline: guard conflicts → add → commit → optional pull
   * → push. No modals; failures are logged and reflected in the status bar.
   *
   * `pullFirst` is used on startup and on the auto-save interval so incoming
   * remote changes are merged while local edits are already committed.
   * `allowEmpty` makes the window-leave sync commit a marker on a clean tree.
   */
  private async silentSync(
    pullFirst = false,
    message = `auto-save: ${formatTimestamp()}`,
    allowEmpty = false,
  ): Promise<void> {
    const git = this.git;
    const env = this.environment;

    if (!git || !env?.available || !env.isRepo) return;
    if (!env.userName || !env.userEmail) return;
    // A manual Git action owns the lock; retry this queued push shortly.
    if (!this.tryAcquireGit()) {
      if (this.pendingPush) this.schedulePushRetry();
      return;
    }

    this.showSyncStatus("⟳ VeloxGit: syncing");
    let committed = false;

    try {
      if (!(await this.ensureIndexUnlocked(git))) {
        this.showSyncStatus("VeloxGit: git index locked", 6000);
        if (this.pendingPush) this.schedulePushRetry();
        return;
      }

      // Never stage or commit on top of unresolved conflicts.
      const status = await git.getStatus();
      if (status.changes.some((change) => change.kind === "conflict")) {
        await this.handlePullConflict();
        return;
      }

      // Skip two Git spawns when the working tree is already clean, unless
      // this sync must leave an empty window-leave marker.
      if (status.changes.length > 0) {
        await git.stageAll();
        committed = await git.commitIfStaged(message, allowEmpty);
      } else if (allowEmpty) {
        committed = await git.commitIfStaged(message, true);
      }

      if (!isOnline()) {
        if (committed || this.pendingPush) {
          this.pendingPush = true;
          this.showSyncStatus("Offline (Commits queued)");
          this.schedulePushRetry();
        } else {
          this.showSyncStatus("");
        }
        return;
      }

      let pulled: PullResult | null = null;
      if (pullFirst) {
        pulled = await git.pull();
        if (pulled.outcome === "conflict") {
          await this.handlePullConflict();
          return;
        }
      }

      const mustPush =
        committed ||
        this.pendingPush ||
        pulled?.outcome === "merged" ||
        pulled?.outcome === "rebased";

      if (mustPush) {
        await git.push();
        this.pendingPush = false;
        this.clearPushRetry();
        this.showSyncStatus("✓ VeloxGit: saved", 2500);
      } else {
        this.showSyncStatus("");
      }

      this.refreshChanges();
    } catch (error) {
      if (isNetworkError(error) || !isOnline()) {
        // Local commits stay safe; retry with backoff until the push lands.
        if (committed || this.pendingPush) {
          this.pendingPush = true;
          this.showSyncStatus("Offline (Commits queued)");
          this.schedulePushRetry();
        } else {
          this.setOfflineStatus();
        }
        console.warn("[VeloxGit] push postponed; remote unreachable");
      } else {
        console.warn("[VeloxGit] silent sync failed", error);
        this.showSyncStatus("VeloxGit: sync failed", 6000);
      }
    } finally {
      this.releaseGit();
    }
  }

  /**
   * A background pull left unmerged files. Stop every automation path and
   * bring the conflicts into view so the user can resolve them.
   */
  private async handlePullConflict(): Promise<void> {
    console.warn("[VeloxGit] background pull conflict; disabling auto-sync");

    // Stop retries first so nothing touches the conflicted index.
    this.pendingPush = false;
    this.clearPushRetry();

    this.settings.enableAutoSave = false;
    this.settings.syncOnSave = false;
    await this.saveSettings();

    this.showSyncStatus("VeloxGit: merge conflict", 15000);
    new Notice(
      "VeloxGit: background pull stopped with conflicts. Auto-sync disabled; resolve the conflicting files, then re-enable it.",
      15000,
    );

    // Open the panel so conflict entries are visible and highlighted.
    await this.activateView();
    this.refreshChanges();
  }

  private setOfflineStatus(): void {
    this.showSyncStatus(this.pendingPush ? "Offline (Commits queued)" : "Offline");
  }

  private handleOnline(): void {
    this.showSyncStatus("");
    if (!this.pendingPush) return;

    // The event can fire before DNS/SSH is usable; silentSync() reschedules
    // itself on failure, so an immediate attempt is safe.
    this.clearPushRetry();
    void this.silentSync();
  }

  /** Retries a queued push with backoff, independent of OS online events. */
  private schedulePushRetry(): void {
    if (this.pendingPush) this.pushRetry.schedule();
  }

  private clearPushRetry(): void {
    this.pushRetry.cancel();
  }

  private showSyncStatus(text: string, clearAfterMs?: number): void {
    const el = this.syncIndicatorEl;
    if (!el) return;

    el.setText(text);
    el.style.display = text.length > 0 ? "" : "none";

    if (this.syncStatusTimer !== null) {
      window.clearTimeout(this.syncStatusTimer);
      this.syncStatusTimer = null;
    }

    if (text.length > 0 && clearAfterMs !== undefined) {
      this.syncStatusTimer = window.setTimeout(() => {
        this.syncStatusTimer = null;
        this.showSyncStatus("");
      }, clearAfterMs);
    }
  }

  private async initializeGit(): Promise<void> {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      this.setStatus("VeloxGit: unsupported vault");
      new Notice("VeloxGit requires a vault stored on the local filesystem.");
      return;
    }

    this.git = new GitService(vaultPath);

    const env = await this.detectEnvironment();
    if (!env) return;

    const problem = this.environmentProblem(env);
    if (problem) {
      new Notice(problem);
      return;
    }

    if (!env.userName || !env.userEmail) {
      this.app.workspace.onLayoutReady(() => {
        const current = this.environment;
        if (current?.isRepo && (!current.userName || !current.userEmail)) {
          this.openIdentityModal(current);
        }
      });
    }

    // A restored sidebar may have rendered before Git was ready.
    this.refreshChanges();
  }

  private async detectEnvironment(): Promise<GitEnvironment | null> {
    if (!this.git) return null;

    try {
      const env = await this.git.checkEnvironment();
      this.environment = env;
      this.applyEnvironmentStatus(env);
      return env;
    } catch (error) {
      console.error("[VeloxGit] Git environment check failed", error);
      this.environment = null;
      this.setStatus("VeloxGit: error");
      new Notice("VeloxGit: Git environment check failed. See console for details.");
      return null;
    }
  }

  private async checkGitEnvironment(): Promise<void> {
    const env = await this.detectEnvironment();
    if (!env) return;

    const identity =
      env.userName && env.userEmail
        ? `${env.userName} <${env.userEmail}>`
        : "not configured";

    new Notice(
      `VeloxGit\nGit: ${env.version ?? "not found"}\nRepository: ${env.isRepo ? "yes" : "no"}\nIdentity: ${identity}`,
      6000,
    );
  }

  private async promptForIdentity(): Promise<void> {
    if (!this.git) {
      new Notice("VeloxGit is still initializing.");
      return;
    }

    const env = await this.detectEnvironment();
    if (!env) return;

    const problem = this.environmentProblem(env);
    if (problem) {
      new Notice(problem);
      return;
    }

    this.openIdentityModal(env);
  }

  private environmentProblem(env: GitEnvironment | null): string | null {
    if (!env) return null;
    if (!env.available) {
      return "VeloxGit: Git is not installed or not available on PATH.";
    }
    if (!env.isRepo) {
      return "VeloxGit: this vault is not a Git repository (.git not found).";
    }
    return null;
  }

  /**
   * Single pre-flight check shared by every Git action. Uses cached
   * environment data to avoid spawning extra processes per action.
   */
  private requireGit(): GitService | null {
    const git = this.git;
    if (!git) {
      new Notice("VeloxGit is still initializing.");
      return null;
    }

    const problem = this.environmentProblem(this.environment);
    if (problem) {
      new Notice(problem);
      return null;
    }

    return git;
  }

  /**
   * Single mutex for Git writes. Manual actions tell the user when another
   * action owns it; the background auto-sync silently skips its turn.
   */
  private tryAcquireGit(): boolean {
    if (this.isGitBusy) return false;
    this.isGitBusy = true;
    return true;
  }

  private releaseGit(): void {
    this.isGitBusy = false;
  }

  private notifyGitBusy(): void {
    new Notice("VeloxGit: another Git operation is running. Try again in a moment.", 3000);
  }

  /**
   * Refuses to start a write while `.git/index.lock` exists. Stale locks are
   * removed; fresh ones belong to another Git process.
   */
  private async ensureIndexUnlocked(git: GitService): Promise<boolean> {
    const state = await git.checkIndexLock();
    if (state === "clear") return true;

    if (state === "stale" && (await git.clearStaleIndexLock())) {
      console.warn("[VeloxGit] removed stale .git/index.lock");
      return true;
    }

    return false;
  }

  private indexLockedMessage(): string {
    return "VeloxGit: another Git process is using this repository (.git/index.lock exists).";
  }

  /** Re-renders the sidebar list only when the panel is actually open. */
  private refreshChanges(): void {
    if (!this.view) return;
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_VELOXGIT).length === 0) return;
    void this.view.refresh();
  }

  /**
   * Opens the diff modal immediately, then fills it when Git responds.
   * A second click replaces the first modal; stale results are discarded.
   */
  private async showDiff(change: FileChange): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    this.diffModal?.close();

    const modal = new DiffModal(this.app, change.path, () => {
      if (this.diffModal === modal) this.diffModal = null;
    });
    this.diffModal = modal;
    modal.open();

    try {
      const diff = await git.getFileDiff(change);
      if (this.diffModal !== modal) return;
      modal.setDiff(diff);
    } catch (error) {
      console.error("[VeloxGit] Diff failed", error);
      if (this.diffModal !== modal) return;
      modal.setError(describeError(error));
    }
  }

  /**
   * Opens the branch switcher. Listing and switching are separate async
   * calls, so the modal appears while Git is still answering.
   */
  private async showBranchPrompt(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    if (this.isGitBusy) {
      this.notifyGitBusy();
      return;
    }

    let status: { branch: string | null };
    let branches: string[];
    try {
      const result = await Promise.all([git.getStatus(), git.listBranches()]);
      status = result[0];
      branches = result[1];
    } catch (error) {
      console.error("[VeloxGit] Branch list failed", error);
      new Notice(`VeloxGit: could not read branches.\n${describeError(error)}`);
      return;
    }

    this.branchModal?.close();

    const modal = new BranchModal(
      this.app,
      status.branch,
      branches,
      async (branch, create) => {
        if (!this.tryAcquireGit()) {
          throw new Error("Another Git operation is running. Try again in a moment.");
        }

        const started = performance.now();

        try {
          if (!(await this.ensureIndexUnlocked(git))) {
            throw new Error(this.indexLockedMessage());
          }

          if (create) {
            await git.createBranch(branch);
          } else {
            await git.checkoutBranch(branch);
          }

          const elapsed = Math.round(performance.now() - started);
          console.debug(`[VeloxGit] branch ${create ? "created" : "switched"}: ${branch} in ${elapsed} ms`);
          new Notice(
            create
              ? `VeloxGit: created and switched to ${branch} in ${elapsed} ms.`
              : `VeloxGit: switched to ${branch} in ${elapsed} ms.`,
            3000,
          );
          this.refreshChanges();
        } finally {
          this.releaseGit();
        }
      },
      () => {
        if (this.branchModal === modal) this.branchModal = null;
      },
    );

    this.branchModal = modal;
    modal.open();
  }

  private async stageAll(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    if (!this.tryAcquireGit()) {
      this.notifyGitBusy();
      return;
    }

    const started = performance.now();

    try {
      if (!(await this.ensureIndexUnlocked(git))) {
        new Notice(this.indexLockedMessage(), 8000);
        return;
      }

      await git.stageAll();
      const elapsed = Math.round(performance.now() - started);
      console.debug(`[VeloxGit] staged all changes in ${elapsed} ms`);
      new Notice(`VeloxGit: all changes staged in ${elapsed} ms.`, 3000);
      this.refreshChanges();
    } catch (error) {
      console.error("[VeloxGit] Stage all failed", error);
      new Notice(`VeloxGit: git add . failed.\n${describeError(error)}`, 8000);
    } finally {
      this.releaseGit();
    }
  }

  private async promptForCommit(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    if (this.commitModal) {
      this.commitModal.close();
      this.commitModal = null;
    }

    this.commitModal = new CommitModal(this.app, async (message) => {
      if (!this.tryAcquireGit()) {
        throw new Error("Another Git operation is running. Try again in a moment.");
      }

      const started = performance.now();

      try {
        if (!(await this.ensureIndexUnlocked(git))) {
          throw new Error(this.indexLockedMessage());
        }

        await git.commit(message);
        const elapsed = Math.round(performance.now() - started);
        console.debug(`[VeloxGit] committed in ${elapsed} ms`);
        new Notice(`VeloxGit: commit created in ${elapsed} ms.`, 3000);
        this.refreshChanges();
      } finally {
        this.releaseGit();
      }
    });

    this.commitModal.open();
  }

  private async push(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    if (!isOnline()) {
      this.pendingPush = true;
      this.showSyncStatus("Offline (Commits queued)");
      this.schedulePushRetry();
      new Notice("VeloxGit: offline. Push postponed until connectivity returns.", 5000);
      return;
    }

    if (!this.tryAcquireGit()) {
      this.notifyGitBusy();
      return;
    }

    const started = performance.now();
    const progress = new Notice("VeloxGit: pushing...", 0);

    try {
      await git.push();
      this.pendingPush = false;
      this.clearPushRetry();
      const elapsed = Math.round(performance.now() - started);
      console.debug(`[VeloxGit] pushed in ${elapsed} ms`);
      progress.setMessage(`VeloxGit: push complete in ${elapsed} ms.`);
      window.setTimeout(() => progress.hide(), 3000);
      this.refreshChanges();
    } catch (error) {
      if (isNetworkError(error) || !isOnline()) {
        this.pendingPush = true;
        this.showSyncStatus("Offline (Commits queued)");
        this.schedulePushRetry();
        console.warn("[VeloxGit] push postponed; remote unreachable");
        progress.setMessage("VeloxGit: offline. Push will retry when online.");
        window.setTimeout(() => progress.hide(), 5000);
      } else {
        const elapsed = Math.round(performance.now() - started);
        console.error("[VeloxGit] Push failed", error);
        progress.setMessage(`VeloxGit: push failed after ${elapsed} ms.\n${describeError(error)}`);
        window.setTimeout(() => progress.hide(), 10000);
      }
    } finally {
      this.releaseGit();
    }
  }

  private async pull(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    if (!isOnline()) {
      this.setOfflineStatus();
      new Notice("VeloxGit: offline. Pull postponed until connectivity returns.", 5000);
      return;
    }

    if (!this.tryAcquireGit()) {
      this.notifyGitBusy();
      return;
    }

    const started = performance.now();
    const progress = new Notice("VeloxGit: pulling...", 0);

    try {
      if (!(await this.ensureIndexUnlocked(git))) {
        progress.hide();
        new Notice(this.indexLockedMessage(), 8000);
        return;
      }

      const result = await git.pull();
      const elapsed = Math.round(performance.now() - started);
      console.debug(`[VeloxGit] pull ${result.outcome} in ${elapsed} ms`, result.output);

      let sticky = false;

      switch (result.outcome) {
        case "up-to-date":
          progress.setMessage(`VeloxGit: already up to date (${elapsed} ms).`);
          break;
        case "fast-forward":
          progress.setMessage(`VeloxGit: pulled new changes (fast-forward) in ${elapsed} ms.`);
          break;
        case "merged":
          progress.setMessage(`VeloxGit: pulled and merged incoming changes in ${elapsed} ms.`);
          break;
        case "rebased":
          progress.setMessage(`VeloxGit: pulled and rebased local changes in ${elapsed} ms.`);
          break;
        case "conflict":
          progress.setMessage(
            "VeloxGit: pull stopped with conflicts. Resolve them in Git, then continue.",
          );
          sticky = true;
          break;
        default:
          progress.setMessage(`VeloxGit: pull complete in ${elapsed} ms.`);
      }

      window.setTimeout(() => progress.hide(), sticky ? 15000 : 3000);
      this.refreshChanges();
    } catch (error) {
      if (isNetworkError(error) || !isOnline()) {
        this.setOfflineStatus();
        console.warn("[VeloxGit] pull postponed; remote unreachable");
        progress.setMessage("VeloxGit: offline. Pull will retry later.");
        window.setTimeout(() => progress.hide(), 5000);
      } else {
        const elapsed = Math.round(performance.now() - started);
        console.error("[VeloxGit] Pull failed", error);
        progress.setMessage(`VeloxGit: pull failed after ${elapsed} ms.\n${describeError(error)}`);
        window.setTimeout(() => progress.hide(), 10000);
      }
    } finally {
      this.releaseGit();
    }
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_VELOXGIT)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;

      await rightLeaf.setViewState({ type: VIEW_TYPE_VELOXGIT, active: true });
      leaf = rightLeaf;
    }

    await workspace.revealLeaf(leaf);
  }

  private openIdentityModal(env: GitEnvironment): void {
    const git = this.git;
    if (!git) return;

    // Avoid stacking modals if the command is triggered twice.
    if (this.identityModal) {
      this.identityModal.close();
      this.identityModal = null;
    }

    this.identityModal = new CredentialsModal(
      this.app,
      { name: env.userName ?? "", email: env.userEmail ?? "" },
      async (identity: GitIdentity) => {
        await git.setIdentity(identity.name, identity.email);

        const env = this.environment;
        if (env) {
          const updated: GitEnvironment = {
            ...env,
            userName: identity.name,
            userEmail: identity.email,
          };
          this.environment = updated;
          this.applyEnvironmentStatus(updated);
        } else {
          this.setStatus("VeloxGit");
        }

        new Notice("VeloxGit: Git identity saved.");
      },
    );

    this.identityModal.open();
  }

  private applyEnvironmentStatus(env: GitEnvironment): void {
    if (!env.available) {
      this.setStatus("VeloxGit: git missing");
    } else if (!env.isRepo) {
      this.setStatus("VeloxGit: no repo");
    } else if (!env.userName || !env.userEmail) {
      this.setStatus("VeloxGit: set identity");
    } else {
      this.setStatus("VeloxGit");
    }
  }

  private setStatus(text: string): void {
    this.statusBarEl?.setText(text);
  }
}

/** Local time formatted as YYYY-MM-DD HH:mm (or HH:mm:ss) for commit messages. */
function formatTimestamp(date = new Date(), withSeconds = false): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

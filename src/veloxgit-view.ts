import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type { FileChange, GitStatus } from "./git-service";

export const VIEW_TYPE_VELOXGIT = "veloxgit-view";

export interface VeloxGitActions {
  stageAll: () => void;
  commit: () => void;
  push: () => void;
  pull: () => void;
  getStatus: () => Promise<GitStatus | null>;
  showDiff: (file: FileChange) => void;
  showBranchPrompt: () => void;
}

const TAGS: Record<FileChange["kind"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "??",
  conflict: "!",
};

// 2 s halves the Git process spawn rate versus 1 s; actions that change
// state still trigger an immediate refresh through the plugin.
const POLL_INTERVAL_MS = 2_000;

/** One rendered file row, reused across polls while its path stays listed. */
interface RowEntry {
  row: HTMLElement;
  badge: HTMLElement;
  path: HTMLElement;
  change: FileChange;
}

/**
 * Compact quick-action panel with a changed-files list underneath.
 * The list refreshes itself every two seconds while the panel is open.
 */
export class VeloxGitView extends ItemView {
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private branchEl: HTMLElement | null = null;
  private branchText = "";
  private refreshToken = 0;
  private refreshing = false;
  private renderedSignature: string | null = null;
  private timer: number | null = null;
  private readonly rows = new Map<string, RowEntry>();
  private emptyEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly actions: VeloxGitActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_VELOXGIT;
  }

  getDisplayText(): string {
    return "VeloxGit";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.style.padding = "8px";
    container.style.boxSizing = "border-box";

    const grid = container.createDiv();
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "1fr 1fr";
    grid.style.gap = "8px";

    this.addQuickAction(grid, "Stage all", "plus-circle", this.actions.stageAll);
    this.addQuickAction(grid, "Commit", "git-commit", this.actions.commit);
    this.addQuickAction(grid, "Push", "upload", this.actions.push);
    this.addQuickAction(grid, "Pull", "download", this.actions.pull);

    const header = container.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.margin = "12px 2px 4px";

    const title = header.createDiv({ text: "Changed files" });
    title.style.fontSize = "12px";
    title.style.fontWeight = "600";
    title.style.textTransform = "uppercase";
    title.style.letterSpacing = "0.04em";
    title.style.opacity = "0.8";

    const right = header.createDiv();
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "6px";

    this.countEl = right.createSpan();
    this.countEl.style.fontSize = "11px";
    this.countEl.style.opacity = "0.6";

    this.listEl = container.createDiv();
    this.listEl.style.display = "flex";
    this.listEl.style.flexDirection = "column";

    const branch = container.createDiv();
    branch.style.display = "flex";
    branch.style.alignItems = "center";
    branch.style.gap = "6px";
    branch.style.marginTop = "10px";
    branch.style.paddingTop = "8px";
    branch.style.borderTop = "1px solid var(--background-modifier-border)";
    branch.style.fontSize = "12px";
    branch.style.cursor = "pointer";
    branch.title = "Switch or create branch";

    const branchIcon = branch.createSpan();
    setIcon(branchIcon, "git-branch");
    this.branchEl = branch.createSpan({ text: "…" });
    this.branchEl.style.overflow = "hidden";
    this.branchEl.style.textOverflow = "ellipsis";
    this.branchEl.style.whiteSpace = "nowrap";
    this.branchText = "…";

    branch.addEventListener("click", () => this.actions.showBranchPrompt());
    branch.addEventListener("mouseenter", () => {
      branch.style.background = "var(--background-modifier-hover)";
    });
    branch.addEventListener("mouseleave", () => {
      branch.style.background = "";
    });

    this.renderedSignature = null;
    await this.refresh();
    this.startPolling();
  }

  async onClose(): Promise<void> {
    this.stopPolling();
    this.refreshToken += 1;
    this.rows.clear();
    this.emptyEl = null;
    this.listEl = null;
    this.countEl = null;
    this.branchEl = null;
    this.branchText = "";
    this.renderedSignature = null;
    this.contentEl.empty();
  }

  /** Re-reads `git status` and re-renders the list. Safe to call often. */
  async refresh(): Promise<void> {
    const listEl = this.listEl;
    // Skip overlapping calls: a slow status must not queue up behind the poll.
    if (!listEl || this.refreshing) return;

    this.refreshing = true;
    const token = (this.refreshToken += 1);

    try {
      const status = await this.actions.getStatus();
      // A newer refresh (or a closed view) wins.
      if (token !== this.refreshToken || this.listEl !== listEl) return;
      // Git may still be initializing; keep the last known state.
      if (!status) return;
      this.setBranch(status.branch);
      this.render(status.changes);
    } catch {
      if (token !== this.refreshToken || this.listEl !== listEl) return;
      this.renderedSignature = null;
      this.rows.clear();
      this.emptyEl = null;
      listEl.empty();
      const error = listEl.createDiv({ text: "Unable to read Git status." });
      error.style.fontSize = "12px";
      error.style.opacity = "0.6";
      if (this.countEl) this.countEl.setText("");
    } finally {
      this.refreshing = false;
    }
  }

  private setBranch(branch: string | null): void {
    const label = branch ?? "detached HEAD";
    if (label === this.branchText) return;

    this.branchText = label;
    this.branchEl?.setText(label);
  }

  private startPolling(): void {
    this.stopPolling();
    this.timer = window.setInterval(() => {
      // Do not spawn Git while Obsidian is minimized/backgrounded.
      if (document.hidden) return;
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private render(changes: FileChange[]): void {
    const listEl = this.listEl;
    if (!listEl) return;

    // Avoid rebuilding the DOM (and flicker) when nothing changed.
    const signature = changes.map((change) => `${change.code}${change.path}`).join("\0");
    if (signature === this.renderedSignature) return;
    this.renderedSignature = signature;

    if (this.countEl) {
      this.countEl.setText(
        changes.length === 0
          ? ""
          : `${changes.length} file${changes.length === 1 ? "" : "s"}`,
      );
    }

    if (changes.length === 0) {
      this.removeRows();
      if (!this.emptyEl) {
        const empty = listEl.createDiv({ text: "No changes" });
        empty.style.fontSize = "12px";
        empty.style.opacity = "0.6";
        empty.style.padding = "4px 2px";
        this.emptyEl = empty;
      }
      return;
    }

    this.emptyEl?.remove();
    this.emptyEl = null;

    // Reuse one row and badge per path; only status transitions repaint text.
    const seen = new Set<string>();
    let index = 0;

    for (const change of changes) {
      seen.add(change.path);
      let entry = this.rows.get(change.path);

      if (!entry) {
        entry = this.createRow(change);
        this.rows.set(change.path, entry);
      } else {
        entry.change = change;
        if (entry.badge.dataset.kind !== change.kind) {
          entry.badge.dataset.kind = change.kind;
          entry.badge.className = `velox-badge velox-badge-${change.kind}`;
          entry.badge.setText(TAGS[change.kind]);
        }
      }

      // Keep DOM order without detaching and recreating nodes.
      if (listEl.children[index] !== entry.row) {
        listEl.insertBefore(entry.row, listEl.children[index] ?? null);
      }
      index += 1;
    }

    for (const [path, entry] of this.rows) {
      if (seen.has(path)) continue;
      entry.row.remove();
      this.rows.delete(path);
    }
  }

  /** Detaches every cached row so a fresh status can rebuild the map. */
  private removeRows(): void {
    for (const entry of this.rows.values()) entry.row.remove();
    this.rows.clear();
  }

  private createRow(change: FileChange): RowEntry {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.padding = "3px 2px";
    row.style.fontSize = "12px";
    row.style.cursor = "pointer";
    row.style.borderRadius = "4px";
    row.title = `View diff: ${change.path}`;
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    // Status indicators render as themed badges; styling lives in styles.css.
    const badge = document.createElement("span");
    badge.className = `velox-badge velox-badge-${change.kind}`;
    badge.dataset.kind = change.kind;
    badge.setText(TAGS[change.kind]);

    const path = document.createElement("span");
    path.setText(change.path);
    path.style.overflow = "hidden";
    path.style.textOverflow = "ellipsis";
    path.style.whiteSpace = "nowrap";

    row.append(badge, path);

    const entry: RowEntry = { row, badge, path, change };

    // Handlers read `entry.change`, so reused rows always open the latest diff.
    row.addEventListener("click", () => this.actions.showDiff(entry.change));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.actions.showDiff(entry.change);
      }
    });
    row.addEventListener("mouseenter", () => {
      row.style.background = "var(--background-modifier-hover)";
    });
    row.addEventListener("mouseleave", () => {
      row.style.background = "";
    });

    return entry;
  }

  private addQuickAction(
    parent: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void,
  ): void {
    const button = parent.createEl("button");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.gap = "6px";
    button.style.padding = "10px 8px";
    button.style.cursor = "pointer";

    const iconEl = button.createSpan();
    setIcon(iconEl, icon);
    button.createSpan({ text: label });

    button.addEventListener("click", onClick);
  }
}

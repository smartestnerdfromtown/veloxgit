import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseBlamePorcelain, type BlameLine } from "./blame";

const DEFAULT_TIMEOUT_MS = 5_000;
// Staging a large vault can legitimately take longer than config checks.
const STAGE_TIMEOUT_MS = 60_000;
// The sidebar polls status once per second; this bounds a stuck call.
const STATUS_TIMEOUT_MS = 10_000;
// Blame of a very large file can take a while on first run.
const BLAME_TIMEOUT_MS = 30_000;
// Diffs are user-triggered, so they get a slightly larger budget.
const DIFF_TIMEOUT_MS = 15_000;
// Checkout can touch many files in a large vault.
const BRANCH_TIMEOUT_MS = 30_000;
// Commit hooks (e.g. pre-commit) may be slow.
const COMMIT_TIMEOUT_MS = 60_000;
// A lock left behind by a crashed Git process older than this is recovered.
const STALE_INDEX_LOCK_MS = 5 * 60_000;
// Network operations get a more generous budget.
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 1024 * 1024;
// Large diffs are rare but legitimate; keep them out of the default buffer.
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

export interface GitEnvironment {
  available: boolean;
  version: string | null;
  isRepo: boolean;
  userName: string | null;
  userEmail: string | null;
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type IndexLockState = "clear" | "busy" | "stale";

export type PullOutcome =
  | "up-to-date"
  | "fast-forward"
  | "merged"
  | "rebased"
  | "pulled"
  | "conflict";

export interface PullResult {
  outcome: PullOutcome;
  output: string;
}

export type FileChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface FileChange {
  /** Repo-relative path, exactly as Git reports it. */
  path: string;
  /** Two-letter porcelain code, e.g. " M", "A ", "??". */
  code: string;
  kind: FileChangeKind;
}

export interface GitStatus {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  changes: FileChange[];
}

/**
 * Thin async wrapper around the Git CLI.
 *
 * Uses execFile (no shell) to avoid shell parsing overhead and injection.
 * Every call has a timeout so a broken Git installation cannot hang Obsidian.
 */
export class GitService {
  constructor(private readonly cwd: string) {}

  /**
   * Runs the independent checks concurrently to keep startup latency low.
   * user.name and user.email are fetched in a single Git invocation; the
   * last matching entry is the effective value (Git lists scopes in
   * ascending precedence order).
   */
  async checkEnvironment(): Promise<GitEnvironment> {
    const [version, isRepo, identity] = await Promise.all([
      this.run(["--version"]),
      this.hasGitEntry(),
      this.getIdentity(),
    ]);

    const available = version.exitCode === 0;

    return {
      available,
      version: available ? version.stdout : null,
      isRepo,
      userName: identity.userName,
      userEmail: identity.userEmail,
    };
  }

  /**
   * Writes the identity to this repository's local config only, so the
   * user's global Git configuration is never modified by the plugin.
   *
   * Sequential on purpose: concurrent `git config` writes can contend for
   * .git/config.lock.
   */
  async setIdentity(name: string, email: string): Promise<void> {
    await this.setConfig("user.name", name);
    await this.setConfig("user.email", email);
  }

  /**
   * Checks for Git's index lock before a write operation. A fresh lock means
   * another Git process is active; an old one was probably left by a crash.
   */
  async checkIndexLock(): Promise<IndexLockState> {
    const lockPath = await this.indexLockPath();
    if (!lockPath) return "clear";

    try {
      const stats = await fs.stat(lockPath);
      return Date.now() - stats.mtimeMs > STALE_INDEX_LOCK_MS
        ? "stale"
        : "busy";
    } catch {
      return "clear";
    }
  }

  /** Removes an old `.git/index.lock`. False when missing or still fresh. */
  async clearStaleIndexLock(): Promise<boolean> {
    const lockPath = await this.indexLockPath();
    if (!lockPath) return false;

    try {
      const stats = await fs.stat(lockPath);
      if (Date.now() - stats.mtimeMs <= STALE_INDEX_LOCK_MS) return false;
      await fs.unlink(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves `index.lock` for normal repositories (`.git` directory) and
   * worktrees (`.git` file containing a `gitdir:` pointer).
   */
  private async indexLockPath(): Promise<string | null> {
    const gitEntry = path.join(this.cwd, ".git");

    try {
      const stats = await fs.stat(gitEntry);
      if (stats.isDirectory()) return path.join(gitEntry, "index.lock");
      if (!stats.isFile()) return null;

      const contents = await fs.readFile(gitEntry, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(contents);
      if (!match) return null;

      return path.join(path.resolve(this.cwd, match[1].trim()), "index.lock");
    } catch {
      return null;
    }
  }

  /**
   * Stages all changes under the vault root (`git add .`).
   * Throws with Git's stderr so the caller can surface a useful error.
   */
  async stageAll(): Promise<void> {
    const result = await this.run(["add", "."], STAGE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git add . failed");
    }
  }

  /**
   * Commits staged changes with the given message.
   * Maps Git's "nothing to commit" output to a clear error.
   */
  async commit(message: string): Promise<void> {
    const result = await this.run(["commit", "-m", message], COMMIT_TIMEOUT_MS);
    if (result.exitCode === 0) return;

    const output = `${result.stderr}\n${result.stdout}`.trim();

    if (/nothing to commit|no changes added to commit/i.test(output)) {
      throw new Error("Nothing to commit. Stage your changes first.");
    }

    throw new Error(result.stderr || output || "git commit failed");
  }

  /**
   * Commits staged changes when there are any. Returns false instead of
   * throwing for the "nothing to commit" case, which the silent auto-save
   * pipeline treats as a normal no-op. `allowEmpty` is used by the exit-sync
   * path so a leave/quit event always leaves a visible marker in git log.
   */
  async commitIfStaged(message: string, allowEmpty = false): Promise<boolean> {
    const args = ["commit", "-m", message];
    if (allowEmpty) args.push("--allow-empty");

    const result = await this.run(args, COMMIT_TIMEOUT_MS);
    if (result.exitCode === 0) return true;

    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (/nothing to commit|no changes added to commit/i.test(output)) {
      return false;
    }

    throw new Error(result.stderr || output || "git commit failed");
  }

  /**
   * Pushes the current branch to its configured upstream.
   *
   * `timeoutMs` lets background syncs use a hard, short timeout so a slow or
   * dead network can never hang the sync pipeline.
   */
  async push(timeoutMs = NETWORK_TIMEOUT_MS): Promise<void> {
    const result = await this.run(["push"], timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "git push failed");
    }
  }

  /**
   * Pulls the configured upstream and classifies the result so the UI can
   * report fast-forwards, merges, rebases, and conflicts distinctly.
   */
  async pull(): Promise<PullResult> {
    let result = await this.run(["pull"], NETWORK_TIMEOUT_MS);
    let output = `${result.stderr}\n${result.stdout}`.trim();

    // Modern Git refuses to guess between merge and rebase for divergent
    // branches. Preserve an explicit user policy; otherwise default to merge.
    if (
      result.exitCode !== 0 &&
      /need to specify how to reconcile divergent branches/i.test(output)
    ) {
      result = await this.run(["pull", "--no-rebase"], NETWORK_TIMEOUT_MS);
      output = `${result.stderr}\n${result.stdout}`.trim();
    }

    if (result.exitCode !== 0) {
      if (/CONFLICT|Automatic merge failed|fix conflicts/i.test(output)) {
        return { outcome: "conflict", output };
      }
      throw new Error(result.stderr || result.stdout || "git pull failed");
    }

    if (/already up[- ]to[- ]date/i.test(output)) {
      return { outcome: "up-to-date", output };
    }
    if (/fast-forward/i.test(output)) {
      return { outcome: "fast-forward", output };
    }
    if (/successfully rebased/i.test(output)) {
      return { outcome: "rebased", output };
    }
    if (/merge made by|merge branch/i.test(output)) {
      return { outcome: "merged", output };
    }

    return { outcome: "pulled", output };
  }

  /**
   * Reads branch + working tree state with one Git process.
   *
   * `--porcelain=v1 -z --branch` puts the `## branch...upstream` header in
   * the first NUL record and avoids quoting/escaping for file paths.
   * Renames are emitted as two records (destination, then source); only the
   * destination is shown in the UI.
   */
  async getStatus(): Promise<GitStatus> {
    const result = await this.run(
      // --no-optional-locks keeps the 1s refresh from fighting user Git
      // actions over .git/index.lock.
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--branch"],
      STATUS_TIMEOUT_MS,
      false,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git status failed");
    }

    return parseStatus(result.stdout);
  }

  /**
   * Fast dirty check for the window-leave fast path. Empty porcelain output
   * means the working tree matches HEAD, so no stage/commit/push is needed.
   */
  async hasChanges(): Promise<boolean> {
    const result = await this.run(
      ["--no-optional-locks", "status", "--porcelain=v1"],
      STATUS_TIMEOUT_MS,
      false,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git status failed");
    }
    return result.stdout.length > 0;
  }

  /**
   * Runs `git blame --porcelain` for one vault-relative file and returns a
   * line-number keyed map of author, author time, and commit summary.
   */
  async getBlame(filePath: string): Promise<Map<number, BlameLine>> {
    if (
      filePath.length === 0 ||
      filePath.includes("\0") ||
      path.isAbsolute(filePath) ||
      filePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Invalid path for git blame");
    }

    const result = await this.run(
      ["--no-optional-locks", "blame", "--porcelain", "--", filePath],
      BLAME_TIMEOUT_MS,
      false,
      MAX_DIFF_BYTES,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git blame failed");
    }

    return parseBlamePorcelain(result.stdout);
  }

  /** Local branch names for the switch modal. */
  async listBranches(): Promise<string[]> {
    const result = await this.run(
      ["branch", "--format=%(refname:short)"],
      STATUS_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "git branch failed");
    }
    if (result.stdout.length === 0) return [];

    return result.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  }

  async checkoutBranch(branch: string): Promise<void> {
    validateBranchName(branch);
    const result = await this.run(["checkout", branch], BRANCH_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git checkout ${branch} failed`);
    }
  }

  async createBranch(branch: string): Promise<void> {
    validateBranchName(branch);
    const result = await this.run(["checkout", "-b", branch], BRANCH_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git checkout -b ${branch} failed`);
    }
  }

  /**
   * Returns the patch for one file.
   *
   * The porcelain code tells us which side has changes, so we avoid spawning
   * Git calls that are guaranteed to return an empty diff. Untracked files go
   * straight to `--no-index`; the empty file provides their full content.
   */
  async getFileDiff(file: FileChange): Promise<string> {
    if (file.kind === "untracked") {
      return this.untrackedDiff(file.path);
    }

    const indexCode = file.code[0];
    const worktreeCode = file.code[1];

    if (worktreeCode !== " ") {
      const unstaged = await this.run(
        ["diff", "--", file.path],
        DIFF_TIMEOUT_MS,
        false,
        MAX_DIFF_BYTES,
      );
      if (unstaged.exitCode !== 0) {
        throw new Error(unstaged.stderr || "git diff failed");
      }
      if (unstaged.stdout.length > 0) return unstaged.stdout;
    }

    if (indexCode !== " " && indexCode !== "?") {
      const staged = await this.run(
        ["diff", "--cached", "--", file.path],
        DIFF_TIMEOUT_MS,
        false,
        MAX_DIFF_BYTES,
      );
      if (staged.exitCode !== 0) {
        throw new Error(staged.stderr || "git diff --cached failed");
      }
      if (staged.stdout.length > 0) return staged.stdout;
    }

    return "";
  }

  private async untrackedDiff(filePath: string): Promise<string> {
    const emptyFile = process.platform === "win32" ? "NUL" : "/dev/null";
    const untracked = await this.run(
      ["diff", "--no-index", "--", emptyFile, filePath],
      DIFF_TIMEOUT_MS,
      false,
      MAX_DIFF_BYTES,
    );
    // Exit code 1 simply means "differences found".
    if (untracked.exitCode > 1) {
      throw new Error(untracked.stderr || "git diff --no-index failed");
    }
    return untracked.stdout;
  }

  /**
   * `.git` can be a directory (normal repository) or a file (worktree).
   */
  private async hasGitEntry(): Promise<boolean> {
    try {
      const stats = await fs.stat(path.join(this.cwd, ".git"));
      return stats.isDirectory() || stats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Reads both identity values from whichever config scope wins. `--null`
   * keeps empty local overrides distinguishable from "not set", which is
   * required for the onboarding prompt.
   */
  private async getIdentity(): Promise<{
    userName: string | null;
    userEmail: string | null;
  }> {
    const result = await this.run([
      "config",
      "--null",
      "--get-regexp",
      "^user\\.(name|email)$",
    ]);

    let userName: string | null = null;
    let userEmail: string | null = null;

    if (result.exitCode !== 0) {
      return { userName, userEmail };
    }

    for (const record of result.stdout.split("\0")) {
      if (!record) continue;

      const newlineIndex = record.indexOf("\n");
      const key = newlineIndex === -1 ? record : record.slice(0, newlineIndex);
      const rawValue = newlineIndex === -1 ? "" : record.slice(newlineIndex + 1);
      const value = rawValue.length > 0 ? rawValue : null;

      if (key === "user.name") {
        userName = value;
      } else if (key === "user.email") {
        userEmail = value;
      }
    }

    return { userName, userEmail };
  }

  private async setConfig(key: string, value: string): Promise<void> {
    const result = await this.run(["config", "--local", key, value]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `git config --local ${key} failed`);
    }
  }

  private run(
    args: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    trimStdout = true,
    maxBuffer = MAX_BUFFER_BYTES,
  ): Promise<GitCommandResult> {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: this.cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer,
          encoding: "utf8",
          env: {
            ...process.env,
            // Never let a Git call block waiting for terminal input.
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
        (error, stdout, stderr) => {
          const exitCode = error
            ? typeof error.code === "number"
              ? error.code
              : 1
            : 0;

          resolve({
            exitCode,
            stdout: trimStdout ? stdout.trim() : stdout,
            // execFile kills timed-out processes; make that explicit so the
            // caller can treat it like a transient network failure.
            stderr: (
              stderr ||
              (error?.killed ? "command timed out" : error?.message) ||
              ""
            ).trim(),
          });
        },
      );
    });
  }
}

/**
 * Maps a two-letter porcelain code to the tag shown in the sidebar.
 * Unmerged/conflict states are checked first because they also contain
 * A/D/U letters.
 */
function classifyChange(code: string): FileChangeKind {
  if (code === "??") return "untracked";
  if (
    code === "UU" ||
    code === "AA" ||
    code === "DD" ||
    code === "AU" ||
    code === "UA" ||
    code === "DU" ||
    code === "UD"
  ) {
    return "conflict";
  }

  const index = code[0];
  const worktree = code[1];

  if (index === "R" || worktree === "R") return "renamed";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "A" || worktree === "A") return "added";
  return "modified";
}

function parseStatus(output: string): GitStatus {
  const records = output.split("\0");
  let branch: string | null = null;
  let start = 0;

  if (records[0]?.startsWith("## ")) {
    branch = parseBranchHeader(records[0].slice(3));
    start = 1;
  }

  const changes: FileChange[] = [];

  for (let index = start; index < records.length; index += 1) {
    const record = records[index];
    // Shortest valid entry is "XY x" (4 chars).
    if (record.length < 4) continue;

    const code = record.slice(0, 2);
    const path = record.slice(3);

    // Copies and renames are followed by the original path; skip it.
    if (code[0] === "R" || code[0] === "C") {
      index += 1;
    }

    changes.push({ path, code, kind: classifyChange(code) });
  }

  return { branch, changes };
}

/**
 * Extracts the branch from the `--branch` header body. Handles upstream
 * tracking info, unborn branches, and detached HEAD.
 */
function parseBranchHeader(header: string): string | null {
  if (header.startsWith("HEAD (no branch)")) return null;

  const unborn = "No commits yet on ";
  if (header.startsWith(unborn)) {
    return header.slice(unborn.length) || null;
  }

  const separator = header.indexOf("...");
  const name = separator === -1 ? header : header.slice(0, separator);
  return name || null;
}

function validateBranchName(branch: string): void {
  if (
    branch.length === 0 ||
    branch.startsWith("-") ||
    // Characters Git rejects in refs; whitespace is included here.
    /[\s~^:?*\[\\\x00-\x1f]/.test(branch)
  ) {
    throw new Error(`"${branch}" is not a valid branch name.`);
  }
}

import type { BlameLine } from "./blame";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Compact relative time such as "just now", "22 hours ago", or "3 days ago". */
export function formatRelativeTime(
  timestampSeconds: number,
  nowMs = Date.now(),
): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);

  if (diff < 45) return "just now";
  if (diff < 90) return "1 minute ago";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} minutes ago`;
  if (diff < HOUR * 1.5) return "1 hour ago";
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hours ago`;
  if (diff < DAY * 2) return "yesterday";
  if (diff < MONTH) return `${Math.floor(diff / DAY)} days ago`;
  if (diff < MONTH * 2) return "1 month ago";
  if (diff < YEAR) return `${Math.floor(diff / MONTH)} months ago`;
  if (diff < YEAR * 2) return "1 year ago";
  return `${Math.floor(diff / YEAR)} years ago`;
}

/** Ghost-text label: `Author, relative time • commit summary`. */
export function formatBlame(entry: BlameLine, nowMs = Date.now()): string {
  const author = entry.author.length > 0 ? entry.author : "Unknown";
  const relative = formatRelativeTime(entry.timestamp, nowMs);

  return entry.summary.length > 0
    ? `${author}, ${relative} • ${entry.summary}`
    : `${author}, ${relative}`;
}

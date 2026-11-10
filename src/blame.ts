/** Metadata for one blamed source line. */
export interface BlameLine {
  /** 1-based line number in the current file. */
  line: number;
  author: string;
  /** Author time as Unix seconds. */
  timestamp: number;
  /** First line of the commit message. */
  summary: string;
}

interface CommitMeta {
  author: string;
  timestamp: number;
  summary: string;
}

// Porcelain header: <sha> <orig-line> <final-line> [<group-size>]
const HEADER_PATTERN = /^(\^?[0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/i;
const TAB = 9;

/**
 * Parses `git blame --porcelain` output into a line-number keyed map.
 *
 * Porcelain repeats the full commit metadata only the first time a commit is
 * seen, so metadata is cached by SHA while the remaining lines reuse it. A
 * group header with a line count is followed by that many `\t`-prefixed
 * content lines.
 */
export function parseBlamePorcelain(output: string): Map<number, BlameLine> {
  const result = new Map<number, BlameLine>();
  if (output.length === 0) return result;

  const lines = output.split("\n");
  const commits = new Map<string, CommitMeta>();
  let index = 0;

  while (index < lines.length) {
    const header = HEADER_PATTERN.exec(lines[index]);
    if (!header) {
      index++;
      continue;
    }

    const sha = header[1];
    const finalLine = Number(header[3]);
    const groupSize = header[4] ? Number(header[4]) : 1;

    index++;
    let meta = commits.get(sha);

    if (!meta) {
      meta = { author: "", timestamp: 0, summary: "" };

      // Metadata runs until the first tab-prefixed content line.
      while (index < lines.length && lines[index].charCodeAt(0) !== TAB) {
        const line = lines[index];
        if (line.startsWith("author ")) {
          meta.author = line.slice(7);
        } else if (line.startsWith("author-time ")) {
          meta.timestamp = Number(line.slice(12)) || 0;
        } else if (line.startsWith("summary ")) {
          meta.summary = line.slice(8);
        }
        index++;
      }

      commits.set(sha, meta);
    } else {
      // Repeated commit: metadata is omitted; skip to the content line.
      while (index < lines.length && lines[index].charCodeAt(0) !== TAB) {
        index++;
      }
    }

    for (let offset = 0; offset < groupSize && index < lines.length; offset++) {
      if (lines[index].charCodeAt(0) !== TAB) break;
      index++;

      const lineNumber = finalLine + offset;
      result.set(lineNumber, {
        line: lineNumber,
        author: meta.author,
        timestamp: meta.timestamp,
        summary: meta.summary,
      });
    }
  }

  return result;
}

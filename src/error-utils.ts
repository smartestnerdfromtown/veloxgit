const MAX_ERROR_LENGTH = 200;

/**
 * Extracts a short, useful message for a Notice. Prefers Git's fatal/error
 * line when present; the full error is always logged to the console.
 */
export function describeError(error: unknown, maxLength = MAX_ERROR_LENGTH): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const line =
    lines.find((candidate) => /^(fatal|error):/i.test(candidate)) ??
    lines[0] ??
    "Unknown error";

  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}

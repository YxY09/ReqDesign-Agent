/**
 * Streaming output utilities — print LLM responses token-by-token to the terminal.
 *
 * Mirrors the Python `streaming.py` module with an async-friendly TypeScript API.
 *
 * @module streaming
 */

import process from "node:process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback pair returned by {@link makeStreamPrinter}. */
export interface StreamPrinter {
  /** Called for each incoming chunk of text. */
  onChunk(text: string): void;
  /** Called once when the stream is finished. */
  done(): void;
}

// ---------------------------------------------------------------------------
// Stream printer
// ---------------------------------------------------------------------------

/**
 * Create a stream printer that writes chunks to `stdout` with a labelled
 * prefix (similar to Claude Code's output style).
 *
 * The first call to `onChunk` emits the `tag` prefix.  Subsequent calls
 * append text directly.  `done()` emits a final newline when at least one
 * chunk was printed.
 *
 * @param tag - Label shown before the streamed text (e.g. `"[PlanningTool]"`).
 * @returns A {@link StreamPrinter} with `onChunk` and `done` callbacks.
 */
export function makeStreamPrinter(tag: string): StreamPrinter {
  let printed = false;

  const onChunk = (text: string): void => {
    if (!printed) {
      process.stdout.write(`  ${tag} `);
      printed = true;
    }
    try {
      process.stdout.write(text);
    } catch {
      // Ignore encoding errors (e.g. emoji on Windows GBK consoles)
    }
  };

  const done = (): void => {
    if (printed) {
      process.stdout.write("\n");
    }
  };

  return { onChunk, done };
}



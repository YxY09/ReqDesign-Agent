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

/** Minimal interface that any LLM client must satisfy for {@link streamLlm}. */
export interface LLMClient {
  /** Stream a JSON-structured response. */
  generateJson<T = unknown>(
    ...args: unknown[]
  ): Promise<T>;
  /** Stream a plain-text response. */
  generateText(...args: unknown[]): Promise<string>;
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

// ---------------------------------------------------------------------------
// Generic streaming LLM call
// ---------------------------------------------------------------------------

/**
 * Invoke an LLM method with streaming output.
 *
 * This is the async counterpart of the Python `stream_llm` helper.  It
 * wraps the call with a {@link StreamPrinter} so that tokens are printed
 * in real-time, and guarantees `done()` is called even on error.
 *
 * @typeParam T - The expected return type (defaults to `unknown`).
 * @param llm    - An object satisfying the {@link LLMClient} interface.
 * @param method - `'json'` to call `generateJson`, `'text'` to call `generateText`.
 * @param args   - Positional arguments forwarded to the LLM method.
 * @param tag    - Label for the stream printer prefix.
 * @returns The parsed LLM response.
 */
export async function streamLlm<T = unknown>(
  llm: LLMClient,
  method: "json" | "text",
  args: unknown[] = [],
  tag = "",
): Promise<T> {
  const { onChunk, done } = makeStreamPrinter(tag);
  try {
    if (method === "json") {
      return (await llm.generateJson<T>(...args, { onChunk })) as T;
    }
    return (await llm.generateText(...args, { onChunk })) as unknown as T;
  } finally {
    done();
  }
}

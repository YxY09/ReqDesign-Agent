export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, shouldRetry, onRetry } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxRetries) break;
      if (shouldRetry && !shouldRetry(error)) throw error;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      onRetry?.(error, attempt);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

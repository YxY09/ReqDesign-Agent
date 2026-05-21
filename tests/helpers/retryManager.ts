/**
 * Retry manager with circuit breaker pattern.
 *
 * Ported from reqdesign/retry_manager.py.
 *
 * Features:
 * - Circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED
 * - Exponential backoff with jitter
 * - Non-retryable error detection
 * - Statistics tracking
 */

import { Logger, setupLogger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Circuit breaker states. */
export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the circuit breaker is open and rejects a request. */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RetryRecord {
  attempt: number;
  error: string;
  errorType: string;
  timestamp: number;
}

interface RetryStats {
  totalAttempts: number;
  consecutiveFailures: number;
  circuitState: string;
  circuitOpenedAt: string | null;
}

// ---------------------------------------------------------------------------
// RetryManager
// ---------------------------------------------------------------------------

export class RetryManager {
  readonly maxRetries: number;
  readonly circuitThreshold: number;
  readonly circuitCooldown: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly jitter: boolean;

  readonly history: RetryRecord[] = [];

  private _circuitState: CircuitState = CircuitState.CLOSED;
  private _consecutiveFailures = 0;
  private _circuitOpenedAt = 0;

  // Non-retryable error types (default: only TypeError)
  static readonly NON_RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
    "TypeError",
  ]);

  private readonly _logger: Logger;

  constructor({
    maxRetries = 3,
    circuitThreshold = 3,
    circuitCooldown = 30,
    baseDelay = 1,
    maxDelay = 10,
    jitter = true,
  }: {
    maxRetries?: number;
    circuitThreshold?: number;
    circuitCooldown?: number;
    baseDelay?: number;
    maxDelay?: number;
    jitter?: boolean;
  } = {}) {
    this.maxRetries = maxRetries;
    this.circuitThreshold = circuitThreshold;
    this.circuitCooldown = circuitCooldown;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.jitter = jitter;
    this._logger = setupLogger("reqdesign.retry");
  }

  // ----------------------------------------------------------------
  // Circuit breaker interface
  // ----------------------------------------------------------------

  /** Current circuit breaker state (auto-transitions OPEN → HALF_OPEN). */
  get circuitState(): CircuitState {
    if (
      this._circuitState === CircuitState.OPEN &&
      this._now() - this._circuitOpenedAt >= this.circuitCooldown
    ) {
      this._circuitState = CircuitState.HALF_OPEN;
      this._logger.info(
        `熔断器: OPEN → HALF_OPEN (冷却 ${this.circuitCooldown.toFixed(1)}s 后尝试探测)`,
      );
    }
    return this._circuitState;
  }

  /** Whether the circuit breaker is open (rejecting requests). */
  isCircuitOpen(): boolean {
    return this.circuitState === CircuitState.OPEN;
  }

  /** Manually reset the circuit breaker to CLOSED. */
  resetCircuit(): void {
    this._circuitState = CircuitState.CLOSED;
    this._consecutiveFailures = 0;
    this._logger.info("熔断器: 手动重置 → CLOSED");
  }

  // ----------------------------------------------------------------
  // Retry execution
  // ----------------------------------------------------------------

  /**
   * Execute a function with circuit breaker protection and exponential backoff.
   *
   * @param fn - Async function to execute.
   * @returns The function's return value.
   * @throws CircuitBreakerOpenError if the circuit is open.
   * @throws The last error if all retries are exhausted.
   */
  async retry<T>(fn: () => Promise<T> | T): Promise<T> {
    // Check circuit breaker
    if (this.circuitState === CircuitState.OPEN) {
      const cooldownLeft =
        this.circuitCooldown - (this._now() - this._circuitOpenedAt);
      throw new CircuitBreakerOpenError(
        `熔断器已打开，请等待 ${Math.ceil(cooldownLeft)}s 后再试。` +
          `连续失败 ${this._consecutiveFailures} 次。`,
      );
    }

    // HALF_OPEN: only allow one probe
    let maxAttempts = Math.max(1, this.maxRetries);
    if (this.circuitState === CircuitState.HALF_OPEN) {
      maxAttempts = 1;
      this._logger.info("熔断器 HALF_OPEN: 执行探测请求");
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this._logger.info(`执行尝试 ${attempt}/${maxAttempts}`);
        const result = await fn();

        // Success → reset circuit breaker
        if (attempt > 1) {
          this._logger.info(`第 ${attempt} 次尝试成功`);
        }
        if (this._circuitState === CircuitState.HALF_OPEN) {
          this._logger.info("熔断器探测成功: HALF_OPEN → CLOSED");
        }
        this._consecutiveFailures = 0;
        this._circuitState = CircuitState.CLOSED;
        return result;
      } catch (e) {
        lastError = e;
        const err = e instanceof Error ? e : new Error(String(e));
        const errorType = err.constructor.name;

        const record: RetryRecord = {
          attempt,
          error: err.message,
          errorType,
          timestamp: this._now(),
        };
        this.history.push(record);

        // Non-retryable error → throw immediately
        if (RetryManager.NON_RETRYABLE_ERRORS.has(errorType)) {
          this._logger.error(
            `第 ${attempt} 次尝试遇到不可重试错误 ${errorType}: ${err.message}，立即停止`,
          );
          throw e;
        }

        this._logger.warn(`第 ${attempt} 次尝试失败: ${err.message}`);

        if (attempt < maxAttempts) {
          const delay = this._calculateDelay(attempt);
          this._logger.info(`等待 ${delay.toFixed(1)} 秒后重试...`);
          await this._sleep(delay * 1000);
        }
      }
    }

    // All attempts failed → increment circuit breaker counter
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= this.circuitThreshold) {
      this._circuitState = CircuitState.OPEN;
      this._circuitOpenedAt = this._now();
      this._logger.error(
        `熔断器触发! CLOSED → OPEN (连续失败 ${this._consecutiveFailures} 次 ≥ 阈值 ${this.circuitThreshold})`,
      );
    }

    this._logger.error(`所有 ${maxAttempts} 次尝试均失败`);
    throw lastError;
  }

  /** Synchronous variant of retry. */
  retrySync<T>(fn: () => T): T {
    if (this.circuitState === CircuitState.OPEN) {
      const cooldownLeft =
        this.circuitCooldown - (this._now() - this._circuitOpenedAt);
      throw new CircuitBreakerOpenError(
        `熔断器已打开，请等待 ${Math.ceil(cooldownLeft)}s 后再试。` +
          `连续失败 ${this._consecutiveFailures} 次。`,
      );
    }

    let maxAttempts = Math.max(1, this.maxRetries);
    if (this.circuitState === CircuitState.HALF_OPEN) {
      maxAttempts = 1;
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = fn();
        if (this._circuitState === CircuitState.HALF_OPEN) {
          this._logger.info("熔断器探测成功: HALF_OPEN → CLOSED");
        }
        this._consecutiveFailures = 0;
        this._circuitState = CircuitState.CLOSED;
        return result;
      } catch (e) {
        lastError = e;
        const err = e instanceof Error ? e : new Error(String(e));
        const errorType = err.constructor.name;

        this.history.push({
          attempt,
          error: err.message,
          errorType,
          timestamp: this._now(),
        });

        if (RetryManager.NON_RETRYABLE_ERRORS.has(errorType)) {
          throw e;
        }

        if (attempt < maxAttempts) {
          const delay = this._calculateDelay(attempt);
          this._sleepSync(delay * 1000);
        }
      }
    }

    this._consecutiveFailures++;
    if (this._consecutiveFailures >= this.circuitThreshold) {
      this._circuitState = CircuitState.OPEN;
      this._circuitOpenedAt = this._now();
    }

    throw lastError;
  }

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  private _calculateDelay(attempt: number): number {
    let delay = Math.min(
      this.baseDelay * Math.pow(2, attempt - 1),
      this.maxDelay,
    );
    if (this.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5); // 50%~100% jitter
    }
    return Math.round(delay * 100) / 100;
  }

  private _now(): number {
    return Date.now() / 1000;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _sleepSync(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait for synchronous variant
    }
  }

  // ----------------------------------------------------------------
  // Utility methods
  // ----------------------------------------------------------------

  /** Get a copy of the retry history. */
  getHistory(): RetryRecord[] {
    return [...this.history];
  }

  /** Clear the retry history. */
  clearHistory(): void {
    this.history.length = 0;
  }

  /** Whether there are any failure records. */
  hasFailures(): boolean {
    return this.history.length > 0;
  }

  /** Get statistics about retry activity. */
  getStats(): RetryStats {
    let openedAtIso: string | null = null;
    if (this._circuitOpenedAt > 0) {
      openedAtIso = new Date(this._circuitOpenedAt * 1000).toISOString();
    }

    return {
      totalAttempts: this.history.length,
      consecutiveFailures: this._consecutiveFailures,
      circuitState: this.circuitState,
      circuitOpenedAt: openedAtIso,
    };
  }
}

/**
 * Circuit Breaker
 *
 * States:
 *   CLOSED   → normal operation; failures counted
 *   OPEN     → fast-fail; no calls pass through until resetTimeMs elapses
 *   HALF_OPEN → one probe call allowed; success → CLOSED, failure → OPEN
 */

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** How long (ms) to stay OPEN before moving to HALF_OPEN. Default: 30 000 */
  resetTimeMs?: number;
  /** Optional label for log messages */
  name?: string;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private lastFailureAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeMs: number;
  private readonly name: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeMs = options.resetTimeMs ?? 30_000;
    this.name = options.name ?? "circuit";
  }

  get currentState(): CircuitState {
    return this.state;
  }

  isOpen(): boolean {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureAt >= this.resetTimeMs) {
        this.state = "HALF_OPEN";
        console.log(`[circuit:${this.name}] → HALF_OPEN (probe allowed)`);
        return false;
      }
      return true;
    }
    return false;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      const err = new Error(
        `[circuit:${this.name}] OPEN — fast-fail (last failure ${Date.now() - this.lastFailureAt}ms ago)`
      );
      (err as any).circuitOpen = true;
      throw err;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      console.log(`[circuit:${this.name}] probe succeeded → CLOSED`);
    }
    this.state = "CLOSED";
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.lastFailureAt = Date.now();

    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      console.warn(`[circuit:${this.name}] probe failed → OPEN`);
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      console.warn(
        `[circuit:${this.name}] ${this.failureCount} consecutive failures → OPEN (reset in ${this.resetTimeMs}ms)`
      );
    }
  }

  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.lastFailureAt = 0;
  }
}

/** Shared circuit breaker for Firebase Messaging calls */
export const firebaseBreaker = new CircuitBreaker({
  name: "firebase",
  failureThreshold: 5,
  resetTimeMs: 30_000,
});

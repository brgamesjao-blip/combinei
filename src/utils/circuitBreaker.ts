import { logger } from './logger';

interface BreakerState { failures: number; lastFailure: number; isOpen: boolean; }

const breakers = new Map<string, BreakerState>();
const THRESHOLD = 5;          // failures before opening
const RESET_TIMEOUT = 60000;  // 1 min before half-open

export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  fallback?: T
): Promise<T> {
  let state = breakers.get(name);
  if (!state) { state = { failures: 0, lastFailure: 0, isOpen: false }; breakers.set(name, state); }

  // Check if open
  if (state.isOpen) {
    if (Date.now() - state.lastFailure > RESET_TIMEOUT) {
      state.isOpen = false; // half-open: try one request
    } else {
      logger.warn('Circuit breaker OPEN', { service: name });
      if (fallback !== undefined) return fallback;
      throw new Error(`Circuit breaker open for ${name}`);
    }
  }

  try {
    const result = await fn();
    state.failures = 0; // success resets
    return result;
  } catch (err) {
    state.failures++;
    state.lastFailure = Date.now();
    if (state.failures >= THRESHOLD) {
      state.isOpen = true;
      logger.error('Circuit breaker TRIPPED', { service: name, failures: state.failures });
    }
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

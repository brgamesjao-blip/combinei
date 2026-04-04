import { withCircuitBreaker } from '../src/utils/circuitBreaker';

describe('withCircuitBreaker', () => {
  it('returns result on success', async () => {
    const result = await withCircuitBreaker('test-ok', async () => 'hello');
    expect(result).toBe('hello');
  });

  it('returns fallback on failure', async () => {
    const result = await withCircuitBreaker(
      'test-fail',
      async () => { throw new Error('boom'); },
      'fallback-value'
    );
    expect(result).toBe('fallback-value');
  });

  it('throws without fallback', async () => {
    await expect(
      withCircuitBreaker('test-throw', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });

  it('opens after threshold failures', async () => {
    const name = 'test-threshold-' + Date.now();
    const fn = async () => { throw new Error('fail'); };

    // Fail 5 times (threshold)
    for (let i = 0; i < 5; i++) {
      await withCircuitBreaker(name, fn, 'fb').catch(() => {});
    }

    // 6th call should get fallback immediately (circuit open)
    const start = Date.now();
    const result = await withCircuitBreaker(name, fn, 'open-fallback');
    expect(result).toBe('open-fallback');
    expect(Date.now() - start).toBeLessThan(50); // Should be instant
  });
});

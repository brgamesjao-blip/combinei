import { TtlCache } from '../src/utils/cache';

describe('TtlCache', () => {
  it('stores and retrieves values', () => {
    const cache = new TtlCache<string>(60);
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('returns null for missing keys', () => {
    const cache = new TtlCache<string>(60);
    expect(cache.get('missing')).toBeNull();
  });

  it('expires entries after TTL', async () => {
    const cache = new TtlCache<string>(0.1); // 100ms
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
    await new Promise(r => setTimeout(r, 150));
    expect(cache.get('key1')).toBeNull();
  });

  it('invalidates specific keys', () => {
    const cache = new TtlCache<string>(60);
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    cache.invalidate('key1');
    expect(cache.get('key1')).toBeNull();
    expect(cache.get('key2')).toBe('value2');
  });

  it('clears all entries', () => {
    const cache = new TtlCache<string>(60);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });
});

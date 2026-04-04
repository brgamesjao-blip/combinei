/** Simple in-memory TTL cache to avoid repeated DB queries per message */
interface CacheEntry<T> { data: T; expiresAt: number; }

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;

  constructor(ttlSeconds = 300) { this.ttlMs = ttlSeconds * 1000; }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
    return entry.data;
  }

  set(key: string, data: T): void {
    this.store.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void { this.store.delete(key); }

  clear(): void { this.store.clear(); }
}

// Global caches
export const clinicaCache = new TtlCache<any>(300);   // 5 min
export const profsCache = new TtlCache<any[]>(300);
export const servsCache = new TtlCache<any[]>(300);

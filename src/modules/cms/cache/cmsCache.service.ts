import crypto from 'crypto';

export interface CacheEntry<T = any> {
  data: T;
  etag: string;
  expiresAt: number;
  tags: string[];
  createdAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  keysCount: number;
  hitRatio: string;
}

export class CmsCacheService {
  private static instance: CmsCacheService;
  private memoryStore: Map<string, CacheEntry> = new Map();
  private tagIndex: Map<string, Set<string>> = new Map();
  private hits: number = 0;
  private misses: number = 0;
  private readonly defaultTtlMs: number = 300_000; // 5 minutes default
  private readonly maxEntries: number = 1000;

  private constructor() {
    // Periodic sweep of expired items every 60 seconds
    if (typeof setInterval !== 'undefined') {
      setInterval(() => this.sweepExpired(), 60_000).unref();
    }
  }

  public static getInstance(): CmsCacheService {
    if (!CmsCacheService.instance) {
      CmsCacheService.instance = new CmsCacheService();
    }
    return CmsCacheService.instance;
  }

  /**
   * Generates a weak ETag based on MD5 checksum of the data
   */
  public generateETag(data: any): string {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    const hash = crypto.createHash('md5').update(raw).digest('hex');
    return `W/"${hash.substring(0, 16)}"`;
  }

  /**
   * Retrieve cached item if present and not expired
   */
  public get<T>(key: string): { data: T; etag: string; isFresh: boolean } | null {
    const entry = this.memoryStore.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.invalidateKey(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return {
      data: entry.data as T,
      etag: entry.etag,
      isFresh: true,
    };
  }

  /**
   * Store data in cache with associated tags and TTL in seconds
   */
  public set<T>(key: string, data: T, ttlSeconds: number = 300, tags: string[] = []): string {
    // If cache reached capacity, evict oldest 10%
    if (this.memoryStore.size >= this.maxEntries) {
      const keysToRemove = Array.from(this.memoryStore.keys()).slice(0, Math.floor(this.maxEntries * 0.1));
      for (const k of keysToRemove) {
        this.invalidateKey(k);
      }
    }

    const etag = this.generateETag(data);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const allTags = [...new Set([...tags, 'all-cms'])];

    const entry: CacheEntry<T> = {
      data,
      etag,
      expiresAt,
      tags: allTags,
      createdAt: Date.now(),
    };

    this.memoryStore.set(key, entry);

    // Index tags
    for (const tag of allTags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(key);
    }

    return etag;
  }

  /**
   * Invalidate a single key
   */
  public invalidateKey(key: string): void {
    const entry = this.memoryStore.get(key);
    if (entry) {
      for (const tag of entry.tags) {
        const set = this.tagIndex.get(tag);
        if (set) {
          set.delete(key);
          if (set.size === 0) this.tagIndex.delete(tag);
        }
      }
      this.memoryStore.delete(key);
    }
  }

  /**
   * Invalidate all keys matching a specific tag (e.g. "page:home", "testimonials", "navigation")
   */
  public invalidateTag(tag: string): number {
    const matchingKeys = this.tagIndex.get(tag);
    if (!matchingKeys || matchingKeys.size === 0) return 0;

    const count = matchingKeys.size;
    const keysArray = Array.from(matchingKeys);
    for (const key of keysArray) {
      this.invalidateKey(key);
    }
    this.tagIndex.delete(tag);
    return count;
  }

  /**
   * Clear all CMS cache
   */
  public clear(): void {
    this.memoryStore.clear();
    this.tagIndex.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Clean expired entries
   */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryStore.entries()) {
      if (now > entry.expiresAt) {
        this.invalidateKey(key);
      }
    }
  }

  /**
   * Diagnostic statistics
   */
  public getStats(): CacheStats {
    const total = this.hits + this.misses;
    const ratio = total > 0 ? ((this.hits / total) * 100).toFixed(2) + '%' : '0.00%';
    return {
      hits: this.hits,
      misses: this.misses,
      keysCount: this.memoryStore.size,
      hitRatio: ratio,
    };
  }
}

export const cmsCache = CmsCacheService.getInstance();


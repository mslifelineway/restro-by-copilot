/** Tiny per-process TTL cache. Swap for Redis when running >1 API instance (P2). */
export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: V) { this.m.set(k, { v, exp: Date.now() + this.ttlMs }); }
  delete(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

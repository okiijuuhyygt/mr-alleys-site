// kv.js — Cloudflare KV 的最小假介面（put／get／delete），測試用
export class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async put(key, value, opts = {}) {
    const buf = value instanceof ArrayBuffer ? value.slice(0) : new TextEncoder().encode(String(value)).buffer;
    this.store.set(key, { value: buf, metadata: opts.metadata ?? null });
  }
  async get(key, opts = {}) {
    const hit = this.store.get(key);
    if (!hit) return null;
    const type = typeof opts === 'string' ? opts : opts.type || 'text';
    if (type === 'arrayBuffer') return hit.value.slice(0);
    return new TextDecoder().decode(hit.value);
  }
  async delete(key) {
    this.store.delete(key);
  }
}

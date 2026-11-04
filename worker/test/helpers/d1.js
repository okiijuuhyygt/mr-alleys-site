// d1.js — 用 node:sqlite 模擬 Cloudflare D1 的最小介面，跑的是真的 migrations SQL。
// 只實作程式有用到的：prepare().bind().first()/run()/all()、batch()（交易）、exec()。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const plain = (row) => (row ? { ...row } : null);

class Stmt {
  constructor(sqlite, sql, params = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    for (const p of params) if (p === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${this.sql}`);
    return new Stmt(this.sqlite, this.sql, params);
  }
  async first(col) {
    const row = plain(this.sqlite.prepare(this.sql).get(...this.params));
    return col ? (row ? row[col] : null) : row;
  }
  async all() {
    return { success: true, results: this.sqlite.prepare(this.sql).all(...this.params).map(plain) };
  }
  async run() {
    return this._runSync();
  }
  _runSync() {
    const r = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  }
  prepare(sql) {
    return new Stmt(this.sqlite, sql);
  }
  async batch(stmts) {
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._runSync());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) {
    this.sqlite.exec(sql);
  }
}

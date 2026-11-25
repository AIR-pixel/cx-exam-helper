/**
 * answer-cache.mjs —— 题目缓存（SQLite, node:sqlite 内置）
 *
 * 目标（04-pc-engine.md §5）：
 *   - 同一道题第二次出现时不再打 AI，直接从缓存返回
 *   - 归一化哈希去重：题干去标点空白 + 选项文本拼串 → sha256
 *   - 记录命中次数 / 最后命中时间，便于观察题库是否真的在工作
 *
 * 表结构：
 *   questions(qkey TEXT PK, stem, options_json, type, answer_json,
 *             created_at, last_hit_at, hits, source)
 *   meta(k TEXT PK, v TEXT)
 *
 * 命中统计：
 *   stats() 返回 { total, hits, bySource: {cache, ai, ocs} }
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { normalizeForHash } from './answer-core.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  qkey        TEXT PRIMARY KEY,
  stem        TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  type        TEXT NOT NULL DEFAULT '',
  answer_json TEXT NOT NULL DEFAULT '{}',
  source      TEXT NOT NULL DEFAULT 'ai',
  created_at  INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(type);
CREATE INDEX IF NOT EXISTS idx_questions_last_hit ON questions(last_hit_at DESC);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class AnswerCache {
  /**
   * @param {string} dbPath SQLite 文件路径，或 ':memory:'
   */
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      const abs = resolve(dbPath);
      mkdirSync(dirname(abs), { recursive: true });
      this.path = abs;
    } else {
      this.path = ':memory:';
    }
    this.db = new DatabaseSync(this.path);
    // WAL 能显著降低并发写锁；内存库不支持
    if (this.path !== ':memory:') {
      try { this.db.exec('PRAGMA journal_mode=WAL'); } catch { /* ignore */ }
    }
    this.db.exec(SCHEMA);
    this._stmtGet = this.db.prepare('SELECT * FROM questions WHERE qkey = ?');
    this._stmtPut = this.db.prepare(`
      INSERT INTO questions (qkey, stem, options_json, type, answer_json, source, created_at, last_hit_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(qkey) DO UPDATE SET
        answer_json = excluded.answer_json,
        source      = excluded.source,
        last_hit_at = excluded.last_hit_at
    `);
    this._stmtHit = this.db.prepare(
      'UPDATE questions SET hits = hits + 1, last_hit_at = ? WHERE qkey = ?');
    this._stmtCount = this.db.prepare('SELECT COUNT(*) AS n FROM questions');
    this._stmtSumHits = this.db.prepare('SELECT COALESCE(SUM(hits),0) AS n FROM questions');
    this._stmtBySource = this.db.prepare(
      'SELECT source, COUNT(*) AS n FROM questions GROUP BY source');
  }

  /**
   * 查缓存。命中会自增 hits 并更新时间。
   * @param {object} q 结构化题目
   * @returns {object|null} { answer, source, hits, createdAt }
   */
  get(q) {
    const key = normalizeForHash(q);
    // 图片题/空题干：没有去重依据，一律不命中（见 normalizeForHash 注释）
    if (!key) return null;
    const row = this._stmtGet.get(key);
    if (!row) return null;
    const now = Date.now();
    this._stmtHit.run(now, key);
    let answer = {};
    try { answer = JSON.parse(row.answer_json); } catch { /* ignore */ }
    return {
      qkey: key,
      answer,
      source: row.source,
      hits: row.hits + 1,
      createdAt: row.created_at,
    };
  }

  /**
   * 写缓存
   * @param {object} q 结构化题目
   * @param {object} answer 归一化作答参数 { mode, type, params }
   * @param {string} [source] ai | ocs | manual
   * @returns {string|null} 写入的键；空题干返回 null（未写入）
   */
  put(q, answer, source = 'ai') {
    const key = normalizeForHash(q);
    // 空题干（图片题）不写缓存：否则所有选项相同的图片题会互相污染
    if (!key) return null;
    const now = Date.now();
    this._stmtPut.run(
      key,
      String(q.stem || ''),
      JSON.stringify(q.options || []),
      String(q.type || ''),
      JSON.stringify(answer || {}),
      source,
      now,
      now,
    );
    return key;
  }

  /** 删一条（调试用） */
  delete(q) {
    const key = normalizeForHash(q);
    if (!key) return null;
    this.db.prepare('DELETE FROM questions WHERE qkey = ?').run(key);
    return key;
  }

  /** 清空题库 */
  clear() {
    this.db.exec('DELETE FROM questions');
  }

  /** 统计 */
  stats() {
    const total = this._stmtCount.get().n;
    const hits = this._stmtSumHits.get().n;
    const bySource = {};
    for (const r of this._stmtBySource.all()) bySource[r.source] = r.n;
    return { path: this.path, total, hits, bySource };
  }

  /** 最近 N 条（人眼核对题库质量用） */
  recent(limit = 20) {
    const rows = this.db.prepare(
      'SELECT qkey, stem, type, source, hits, last_hit_at AS lastHitAt FROM questions ORDER BY last_hit_at DESC LIMIT ?'
    ).all(Math.max(1, Math.min(500, Number(limit) || 20)));
    return rows.map((r) => ({
      qkey: r.qkey,
      stem: String(r.stem).slice(0, 80),
      type: r.type,
      source: r.source,
      hits: r.hits,
      lastHitAt: r.lastHitAt,
    }));
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export default AnswerCache;
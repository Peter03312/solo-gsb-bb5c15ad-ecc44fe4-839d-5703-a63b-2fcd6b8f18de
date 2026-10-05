import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dbFile = process.env.DB_FILE || join(__dirname, '..', '..', 'data', 'orienteering.db');
  mkdirSync(dirname(dbFile), { recursive: true });
  _db = new Database(dbFile);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initDb(db = getDb()) {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migratePunchOriginals(db);
  migrateStopwatch(db);
  migrateDivisions(db);
}

/**
 * 旧库迁移：组别赛道功能新增列/表。
 * - division / division_group / division_group_point / runner_division 为新表，
 *   CREATE TABLE IF NOT EXISTS 已自动建立（旧库初始为空：全部选手沿用默认赛道）；
 * - publication 增加 divisions_json（旧发布版冻结当时无组别配置，回填空组别/空归属）；
 * - published_result 增加 division_code 与 group_rank：旧版发布时所有完赛者同属
 *   默认赛道，组内名次即全场名次，回填 group_rank = rank_no（未完赛者两列均为 NULL）。
 * 幂等：列已存在时跳过。
 */
function migrateDivisions(db) {
  const pubCols = db.prepare('PRAGMA table_info(publication)').all().map((c) => c.name);
  if (!pubCols.includes('divisions_json'))
    db.exec(`ALTER TABLE publication ADD COLUMN divisions_json TEXT NOT NULL DEFAULT '{"divisions":[],"assignments":[]}'`);
  const resCols = db.prepare('PRAGMA table_info(published_result)').all().map((c) => c.name);
  if (!resCols.includes('division_code'))
    db.exec('ALTER TABLE published_result ADD COLUMN division_code TEXT');
  if (!resCols.includes('group_rank')) {
    db.exec('ALTER TABLE published_result ADD COLUMN group_rank INTEGER');
    db.prepare('UPDATE published_result SET group_rank = rank_no WHERE group_rank IS NULL AND rank_no IS NOT NULL').run();
  }
}

/**
 * 旧库迁移：停表功能新增列/表。
 * - stoppage_interval 为新表，CREATE TABLE IF NOT EXISTS 已自动建立；
 * - publication 增加 stoppages_json（旧发布版冻结当时无停表配置，回填 '[]'）；
 * - published_result 增加 net_elapsed（旧版净耗时即原始耗时，回填 elapsed）。
 * 幂等：列已存在时跳过。
 */
function migrateStopwatch(db) {
  const pubCols = db.prepare('PRAGMA table_info(publication)').all().map((c) => c.name);
  if (!pubCols.includes('stoppages_json'))
    db.exec("ALTER TABLE publication ADD COLUMN stoppages_json TEXT NOT NULL DEFAULT '[]'");
  const resCols = db.prepare('PRAGMA table_info(published_result)').all().map((c) => c.name);
  if (!resCols.includes('net_elapsed')) {
    db.exec('ALTER TABLE published_result ADD COLUMN net_elapsed INTEGER');
    // 旧发布版发布时尚无停表区间：净耗时 = 原始耗时（未完赛者两列均为 NULL）
    db.prepare('UPDATE published_result SET net_elapsed = elapsed WHERE net_elapsed IS NULL AND elapsed IS NOT NULL').run();
  }
}

/**
 * 旧库迁移：为 punch 增补「首次入库原始读数」列。
 * 首次入库后只有裁判更正会改 point/seconds，且每条 correct 审计的
 * orig_point/orig_seconds 记录的是「更正发生时的现值」；因此取最早一条
 * correct 审计即得最初读数（多次更正后仍准确）。无审计的记录原值即现值。
 * 幂等：列已存在时直接返回。
 */
function migratePunchOriginals(db) {
  const cols = db.prepare("PRAGMA table_info(punch)").all().map((c) => c.name);
  if (cols.includes('orig_point')) return;
  db.exec('ALTER TABLE punch ADD COLUMN orig_bib TEXT');
  db.exec('ALTER TABLE punch ADD COLUMN orig_point TEXT');
  db.exec('ALTER TABLE punch ADD COLUMN orig_seconds INTEGER');
  db.exec('ALTER TABLE punch ADD COLUMN orig_kind TEXT');
  db.prepare(
    `UPDATE punch
        SET orig_bib = bib,
            orig_point = COALESCE(
              (SELECT a.orig_point FROM punch_audit a
               WHERE a.punch_id = punch.id AND a.action = 'correct'
               ORDER BY a.id LIMIT 1), point),
            orig_seconds = COALESCE(
              (SELECT a.orig_seconds FROM punch_audit a
               WHERE a.punch_id = punch.id AND a.action = 'correct'
               ORDER BY a.id LIMIT 1), seconds),
            orig_kind = kind`
  ).run();
}

/** 推进赛事修订号并返回新值（任何配置/读数/更正变化都使旧修订过期） */
export const bumpRevision = db =>
  db.prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision').get().revision;

export function currentRevision(db = getDb()) {
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  return row ? row.revision : null;
}

import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, initDb, bumpRevision, currentRevision } from './db.mjs';
import { loadConfig, computeResults, mergeIntervals } from './scoring.mjs';
import {
  validateOperations, canonicalOps, signPreview, verifyPreview,
  previewCase, commitCase,
} from './appeals.mjs';
import { seedDemo } from './seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const db = getDb();
initDb(db);
if (process.env.SEED === '1') seedDemo(db);

// ---------- 工具 ----------
function badRequest(res, message) {
  return res.status(400).json({ error: message });
}
/** 修订号核对：导入/发布等操作须基于当前赛事修订，过期返回当前修订。
 *  通过返回 true；过期/非法时已写出响应并返回 false。空库修订为 0。 */
function checkRevision(req, res) {
  const expectedRaw = req.body?.expectedRevision ?? req.query?.expectedRevision;
  const expected = Number(expectedRaw);
  if (expectedRaw == null || !Number.isInteger(expected) || expected < 0) {
    res.status(400).json({ error: '缺少 expectedRevision' });
    return false;
  }
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  const cur = row ? row.revision : 0;
  if (expected !== cur) {
    res.status(409).json({ error: '赛事已修订，请刷新后重试', currentRevision: cur });
    return false;
  }
  return true;
}

/** 组别赛道对外形态（有序关卡 + 替代点位 + 组/终点截止） */
function divisionView(d) {
  return {
    code: d.code,
    name: d.name,
    finishCutoff: d.finish_cutoff,
    groups: d.groups.map((g) => ({ seq: g.seq, name: g.name, cutoffSecs: g.cutoff_secs, points: g.points })),
  };
}
/** 选手归属对外形态：[{ bib, divisionCode }]，按号码布排序 */
function assignmentsView(cfg) {
  const codeById = new Map(cfg.divisions.map((d) => [d.id, d.code]));
  return Object.entries(cfg.assignments)
    .map(([bib, divId]) => ({ bib, divisionCode: codeById.get(divId) ?? null }))
    .filter((a) => a.divisionCode != null)
    .sort((a, b) => a.bib.localeCompare(b.bib));
}

// ---------- 赛事配置 ----------
app.get('/api/event', (req, res) => {
  const cfg = loadConfig(db);
  if (!cfg) return res.json({ configured: false, revision: 0 });
  res.json({
    configured: true,
    id: cfg.id,
    name: cfg.name,
    startPoint: cfg.start_point,
    finishPoint: cfg.finish_point,
    finishCutoff: cfg.finish_cutoff,
    revision: cfg.revision,
    groups: cfg.groups.map((g) => ({
      seq: g.seq,
      name: g.name,
      cutoffSecs: g.cutoff_secs,
      points: g.points,
    })),
    // 组别赛道与选手归属（未分组选手沿用上方默认赛道）
    divisions: cfg.divisions.map(divisionView),
    assignments: assignmentsView(cfg),
    // 统一停表区间（已合并的不交并集）
    stoppages: cfg.stoppages.map((s) => ({ startSecs: s.start, endSecs: s.end })),
  });
});

/** 主办方设置/重设关卡组（整体替换；历史发布版已冻结配置，不受影响） */
app.post('/api/setup', (req, res) => {
  if (!checkRevision(req, res)) return;
  const { name, startPoint, finishPoint, finishCutoff, groups } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return badRequest(res, '赛事名称必填');
  if (typeof startPoint !== 'string' || !startPoint.trim()) return badRequest(res, '起点必填');
  if (typeof finishPoint !== 'string' || !finishPoint.trim()) return badRequest(res, '终点必填');
  if (startPoint === finishPoint) return badRequest(res, '起点与终点不能相同');
  if (!Number.isInteger(finishCutoff) || finishCutoff < 0) return badRequest(res, '终点截止秒数须为非负整数');
  if (!Array.isArray(groups) || groups.length === 0) return badRequest(res, '至少设置一个关卡组');

  const normGroups = [];
  const allPoints = new Set();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || typeof g.name !== 'string' || !g.name.trim()) return badRequest(res, `第 ${i + 1} 组名称非法`);
    const cutoff = g.cutoffSecs == null ? null : g.cutoffSecs;
    if (cutoff != null && (!Number.isInteger(cutoff) || cutoff < 0))
      return badRequest(res, `「${g.name}」截止秒数须为非负整数或留空`);
    if (!Array.isArray(g.points) || g.points.length === 0)
      return badRequest(res, `「${g.name}」至少一个点位`);
    const pts = [];
    for (const p of g.points) {
      if (typeof p !== 'string' || !p.trim()) return badRequest(res, `「${g.name}」存在非法点位`);
      if (pts.includes(p)) return badRequest(res, `「${g.name}」点位 ${p} 重复`);
      if (allPoints.has(p)) return badRequest(res, `点位 ${p} 在多个组中出现`);
      if (p === startPoint || p === finishPoint) return badRequest(res, `点位 ${p} 不能与起点/终点相同`);
      pts.push(p);
      allPoints.add(p);
    }
    normGroups.push({ name: g.name.trim(), cutoffSecs: cutoff, points: pts });
  }

  const rev = db.transaction(() => {
    db.prepare('DELETE FROM group_point').run();
    db.prepare('DELETE FROM checkpoint_group').run();
    db.prepare(
      `INSERT INTO event (id, name, start_point, finish_point, finish_cutoff, revision)
       VALUES (1, @name, @sp, @fp, @fc, 0)
       ON CONFLICT(id) DO UPDATE SET
         name=@name, start_point=@sp, finish_point=@fp, finish_cutoff=@fc`
    ).run({ name: name.trim(), sp: startPoint.trim(), fp: finishPoint.trim(), fc: finishCutoff });
    const insG = db.prepare('INSERT INTO checkpoint_group (seq, name, cutoff_secs) VALUES (?, ?, ?)');
    const insP = db.prepare('INSERT INTO group_point (group_id, point, seq) VALUES (?, ?, ?)');
    normGroups.forEach((g, i) => {
      const gid = insG.run(i + 1, g.name, g.cutoffSecs).lastInsertRowid;
      g.points.forEach((p, j) => insP.run(gid, p, j + 1));
    });
    // 空库（修订 0）首次设置落为修订 #1；之后每次修改继续推进
    return bumpRevision(db);
  })();
  res.json({ ok: true, revision: rev });
});

// ---------- 组别赛道与选手归属 ----------
/**
 * 规范化并整次校验组别赛道与归属；任一非法返回 { error }（整次拒绝，不部分写入）。
 * 规则：组别代码唯一非空、名称非空、终点截止为非负整数、至少一个有序关卡组；
 * 每组名称非空、替代点位至少一个（空替代点位整次拒绝）、点位不与起点/终点相同、
 * 同一组别赛道内点位不跨组重复（不同组别赛道可共用点位）；
 * 归属中号码布不得重复（重复归属整次拒绝）、组别代码必须存在于本次提交（未知组别整次拒绝）。
 */
function parseDivisions(rawDivisions, rawAssignments, cfg) {
  if (!Array.isArray(rawDivisions))
    return { error: 'divisions 须为数组（可空，空数组表示清除全部组别与归属）' };
  const divisions = [];
  const codes = new Set();
  for (let i = 0; i < rawDivisions.length; i++) {
    const d = rawDivisions[i];
    const where = `第 ${i + 1} 个组别`;
    if (!d || typeof d !== 'object') return { error: `${where} 格式非法，整次拒绝` };
    const code = typeof d.code === 'string' ? d.code.trim() : '';
    if (!code) return { error: `${where}：组别代码必填，整次拒绝` };
    if (codes.has(code)) return { error: `组别代码「${code}」重复，整次拒绝` };
    if (typeof d.name !== 'string' || !d.name.trim())
      return { error: `组别「${code}」名称必填，整次拒绝` };
    if (!Number.isInteger(d.finishCutoff) || d.finishCutoff < 0)
      return { error: `组别「${code}」终点截止秒数须为非负整数，整次拒绝` };
    if (!Array.isArray(d.groups) || d.groups.length === 0)
      return { error: `组别「${code}」至少设置一个有序关卡组，整次拒绝` };
    const groups = [];
    const usedPoints = new Set();
    for (let j = 0; j < d.groups.length; j++) {
      const g = d.groups[j];
      if (!g || typeof g.name !== 'string' || !g.name.trim())
        return { error: `组别「${code}」第 ${j + 1} 组名称非法，整次拒绝` };
      const cutoff = g.cutoffSecs == null ? null : g.cutoffSecs;
      if (cutoff != null && (!Number.isInteger(cutoff) || cutoff < 0))
        return { error: `组别「${code}」组「${g.name}」截止秒数须为非负整数或留空，整次拒绝` };
      if (!Array.isArray(g.points) || g.points.length === 0)
        return { error: `组别「${code}」组「${g.name}」替代点位为空，整次拒绝` };
      const pts = [];
      for (const p of g.points) {
        if (typeof p !== 'string' || !p.trim())
          return { error: `组别「${code}」组「${g.name}」存在非法点位，整次拒绝` };
        const pt = p.trim();
        if (pts.includes(pt))
          return { error: `组别「${code}」组「${g.name}」点位 ${pt} 重复，整次拒绝` };
        if (pt === cfg.start_point || pt === cfg.finish_point)
          return { error: `点位 ${pt} 不能与起点/终点相同，整次拒绝` };
        if (usedPoints.has(pt))
          return { error: `点位 ${pt} 在组别「${code}」的多个组中出现，整次拒绝` };
        pts.push(pt);
        usedPoints.add(pt);
      }
      groups.push({ name: g.name.trim(), cutoffSecs: cutoff, points: pts });
    }
    codes.add(code);
    divisions.push({ code, name: d.name.trim(), finishCutoff: d.finishCutoff, groups });
  }

  const assignments = [];
  const seenBibs = new Set();
  const rawList = rawAssignments == null ? [] : rawAssignments;
  if (!Array.isArray(rawList)) return { error: 'assignments 须为数组（可空），整次拒绝' };
  for (const a of rawList) {
    if (!a || typeof a !== 'object') return { error: '归属记录格式非法，整次拒绝' };
    const bib = typeof a.bib === 'string' ? a.bib.trim() : '';
    const code = typeof a.divisionCode === 'string' ? a.divisionCode.trim() : '';
    if (!bib) return { error: '归属记录缺少号码布，整次拒绝' };
    if (seenBibs.has(bib)) return { error: `号码布 ${bib} 重复归属，整次拒绝` };
    if (!codes.has(code))
      return { error: `号码布 ${bib} 归属未知组别「${code || '(空)'}」，整次拒绝` };
    seenBibs.add(bib);
    assignments.push({ bib, divisionCode: code });
  }
  return { divisions, assignments };
}

/** 与当前库中配置比较：组别赛道与归属完全一致时为只读操作（不推进修订号） */
function divisionsEqual(cfg, divisions, assignments) {
  const cur = cfg.divisions.map(divisionView).map((d) => ({
    code: d.code, name: d.name, finishCutoff: d.finishCutoff,
    groups: d.groups.map((g) => ({ name: g.name, cutoffSecs: g.cutoffSecs, points: g.points })),
  }));
  const next = divisions.map((d) => ({
    code: d.code, name: d.name, finishCutoff: d.finishCutoff,
    groups: d.groups.map((g) => ({ name: g.name, cutoffSecs: g.cutoffSecs, points: g.points })),
  }));
  if (JSON.stringify(cur) !== JSON.stringify(next)) return false;
  const curAsg = assignmentsView(cfg);
  const nextAsg = [...assignments].sort((a, b) => a.bib.localeCompare(b.bib));
  return JSON.stringify(curAsg) === JSON.stringify(nextAsg);
}

app.get('/api/divisions', (req, res) => {
  const cfg = loadConfig(db);
  if (!cfg) return res.json({ configured: false, revision: 0, divisions: [], assignments: [] });
  res.json({
    configured: true,
    revision: cfg.revision,
    divisions: cfg.divisions.map(divisionView),
    assignments: assignmentsView(cfg),
  });
});

/**
 * POST /api/divisions 整体替换组别赛道与选手归属（原子生效）：
 * body: { expectedRevision,
 *         divisions: [{ code, name, finishCutoff,
 *                       groups: [{ name, cutoffSecs?, points: [...] }] }],
 *         assignments: [{ bib, divisionCode }] }
 * 未知组别 / 重复归属 / 空替代点位等任一非法 => 400 整次拒绝（不部分写入）；
 * 修订号过期 => 409 + currentRevision；提交内容与现有完全一致 => 只读，不推进修订。
 * 归属的号码布若尚未有打卡，会自动登记选手（等待读数，状态为无出发）。
 */
app.post('/api/divisions', (req, res) => {
  if (!checkRevision(req, res)) return;
  const cfg = loadConfig(db);
  if (!cfg) return badRequest(res, '赛事尚未配置，请先设置关卡组');
  const parsed = parseDivisions(req.body?.divisions, req.body?.assignments, cfg);
  if (parsed.error) return badRequest(res, parsed.error);
  const { divisions, assignments } = parsed;

  let revision = cfg.revision;
  const changed = !divisionsEqual(cfg, divisions, assignments);
  if (changed) {
    revision = db.transaction(() => {
      // 整体替换：删除旧组别（关卡组/点位/归属随外键级联清除）后重建
      db.prepare('DELETE FROM division').run();
      const insD = db.prepare('INSERT INTO division (code, name, finish_cutoff, seq) VALUES (?, ?, ?, ?)');
      const insG = db.prepare('INSERT INTO division_group (division_id, seq, name, cutoff_secs) VALUES (?, ?, ?, ?)');
      const insP = db.prepare('INSERT INTO division_group_point (group_id, point, seq) VALUES (?, ?, ?)');
      const divIdByCode = new Map();
      divisions.forEach((d, i) => {
        const did = insD.run(d.code, d.name, d.finishCutoff, i + 1).lastInsertRowid;
        divIdByCode.set(d.code, did);
        d.groups.forEach((g, j) => {
          const gid = insG.run(did, j + 1, g.name, g.cutoffSecs).lastInsertRowid;
          g.points.forEach((p, k) => insP.run(gid, p, k + 1));
        });
      });
      const insRunner = db.prepare('INSERT INTO runner (bib, name) VALUES (?, NULL) ON CONFLICT(bib) DO NOTHING');
      const insA = db.prepare('INSERT INTO runner_division (bib, division_id) VALUES (?, ?)');
      for (const a of assignments) {
        insRunner.run(a.bib); // 尚未导入打卡的号码布也可先归属
        insA.run(a.bib, divIdByCode.get(a.divisionCode));
      }
      return bumpRevision(db);
    })();
  }
  res.json({
    ok: true,
    revision,
    changed,
    divisions,
    assignments: [...assignments].sort((a, b) => a.bib.localeCompare(b.bib)),
  });
});

// ---------- 统一停表区间 ----------
/** 规范化并整次校验停表区间；任一非法返回 { error }（整次拒绝，不部分写入）。 */
function parseStoppages(raw) {
  if (!Array.isArray(raw)) return { error: 'stoppages 须为数组（可空，空数组表示清除全部区间）' };
  const list = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const where = `第 ${i + 1} 个区间`;
    if (!s || typeof s !== 'object') return { error: `${where} 格式非法，整次拒绝` };
    const start = s.startSecs;
    const end = s.endSecs;
    if (!Number.isInteger(start) || !Number.isInteger(end))
      return { error: `${where}：起止秒数须为非负整数，整次拒绝` };
    if (start < 0 || end < 0)
      return { error: `${where}：起止秒数不能为负，整次拒绝` };
    if (start >= end)
      return { error: `${where}：起点（${start}）必须小于终点（${end}），整次拒绝` };
    list.push({ start, end });
  }
  // 统一合并重叠/相邻区间后存储与比较（重叠区间只计一次）
  return { intervals: mergeIntervals(list) };
}

function intervalsEqual(a, b) {
  return a.length === b.length && a.every((x, i) => x.start === b[i].start && x.end === b[i].end);
}

app.get('/api/stoppages', (req, res) => {
  const cfg = loadConfig(db);
  if (!cfg) return res.json({ configured: false, revision: 0, stoppages: [] });
  res.json({
    configured: true,
    revision: cfg.revision,
    stoppages: cfg.stoppages.map((s) => ({ startSecs: s.start, endSecs: s.end })),
  });
});

/**
 * POST /api/stoppages 整体替换停表区间集合：
 * body: { expectedRevision, stoppages: [{ startSecs, endSecs }, ...] }
 * 任一区间非法（非整数/负数/起点≥终点）=> 400 整次拒绝（不部分写入）；
 * 修订号过期 => 409 + currentRevision；提交内容与现有并集完全相同 => 只读，不推进修订。
 */
app.post('/api/stoppages', (req, res) => {
  if (!checkRevision(req, res)) return;
  if (!loadConfig(db)) return badRequest(res, '赛事尚未配置，请先设置关卡组');
  const parsed = parseStoppages(req.body?.stoppages);
  if (parsed.error) return badRequest(res, parsed.error);
  const next = parsed.intervals;

  const cur = mergeIntervals(
    db.prepare('SELECT start_secs AS start, end_secs AS end FROM stoppage_interval').all()
  );
  let revision = currentRevision(db);
  if (!intervalsEqual(cur, next)) {
    revision = db.transaction(() => {
      db.prepare('DELETE FROM stoppage_interval').run();
      const ins = db.prepare('INSERT INTO stoppage_interval (start_secs, end_secs) VALUES (?, ?)');
      for (const iv of next) ins.run(iv.start, iv.end);
      return bumpRevision(db);
    })();
  }
  res.json({
    ok: true,
    revision,
    changed: !intervalsEqual(cur, next),
    stoppages: next.map((s) => ({ startSecs: s.start, endSecs: s.end })),
  });
});
/**
 * 整批校验：负秒数、同记录号异「原始内容」=> 整批拒绝（事务回滚）。
 * 同号判定以该记录号【首次入库时】的原始读数（bib/point/seconds/kind）为准，
 * 不看裁判更正后的现值：
 *  - 原始内容一致 => 幂等跳过，绝不覆盖现值、作废状态与审计留痕；
 *  - 原始内容不一致（批内或库内）=> 整批拒绝；即使批次混有新记录也不部分入库。
 */
app.post('/api/punches/import', (req, res) => {
  if (!checkRevision(req, res)) return;
  if (!loadConfig(db)) return badRequest(res, '赛事尚未配置，请先设置关卡组');
  const { punches } = req.body || {};
  if (!Array.isArray(punches) || punches.length === 0) return badRequest(res, 'punches 须为非空数组');

  const rows = [];
  const seen = new Map();
  for (let i = 0; i < punches.length; i++) {
    const p = punches[i];
    const where = `第 ${i + 1} 条`;
    if (!p || typeof p.recordNo !== 'string' || !p.recordNo.trim()) return badRequest(res, `${where}: recordNo 必填`);
    if (typeof p.bib !== 'string' || !p.bib.trim()) return badRequest(res, `${where}: bib 必填`);
    if (typeof p.point !== 'string' || !p.point.trim()) return badRequest(res, `${where}: point 必填`);
    if (!Number.isInteger(p.seconds) || p.seconds < 0)
      return badRequest(res, `${where}（记录号 ${p.recordNo}）: 秒数须为非负整数，负秒数整批拒绝`);
    if (!['start', 'enroute', 'finish'].includes(p.kind))
      return badRequest(res, `${where}: kind 须为 start/enroute/finish`);
    const row = {
      record_no: p.recordNo.trim(), bib: p.bib.trim(), point: p.point.trim(),
      seconds: p.seconds, kind: p.kind, name: typeof p.name === 'string' ? p.name.trim() : null,
    };
    if (seen.has(row.record_no)) {
      const prev = seen.get(row.record_no);
      if (prev.bib !== row.bib || prev.point !== row.point || prev.seconds !== row.seconds || prev.kind !== row.kind)
        return badRequest(res, `记录号 ${row.record_no} 在批次内出现且原始内容不一致，整批拒绝`);
      continue; // 批次内完全重复，幂等忽略
    }
    seen.set(row.record_no, row);
    rows.push(row);
  }

  // 与库中「首次入库原始读数」比对：更正后的现值不参与冲突判定。
  const existing = db.prepare(
    'SELECT record_no, orig_bib, orig_point, orig_seconds, orig_kind FROM punch WHERE record_no = ?'
  );
  for (const r of rows) {
    const ex = existing.get(r.record_no);
    if (ex && (ex.orig_bib !== r.bib || ex.orig_point !== r.point ||
               ex.orig_seconds !== r.seconds || ex.orig_kind !== r.kind))
      return badRequest(res, `记录号 ${r.record_no} 已存在但原始内容不同，整批拒绝`);
  }

  let inserted = 0;
  const present = new Set(
    db.prepare(`SELECT record_no FROM punch WHERE record_no IN (${rows.map(() => '?').join(',')})`)
      .all(...rows.map((r) => r.record_no))
      .map((x) => x.record_no)
  );
  const toInsert = rows.filter((r) => !present.has(r.record_no));
  // 仅当确有新记录时才写库/推进修订；全部幂等跳过时为只读操作，修订号不变。
  let revision = currentRevision(db);
  if (toInsert.length > 0) {
    revision = db.transaction(() => {
      const insRunner = db.prepare('INSERT INTO runner (bib, name) VALUES (?, ?) ON CONFLICT(bib) DO UPDATE SET name = COALESCE(excluded.name, runner.name)');
      const insPunch = db.prepare(
        `INSERT INTO punch (record_no, bib, point, seconds, kind, orig_bib, orig_point, orig_seconds, orig_kind)
         VALUES (@record_no, @bib, @point, @seconds, @kind, @bib, @point, @seconds, @kind)`
      );
      for (const r of toInsert) {
        insRunner.run(r.bib, r.name);
        inserted += insPunch.run(r).changes;
      }
      return bumpRevision(db);
    })();
  }
  res.json({ ok: true, inserted, skipped: rows.length - inserted, revision });
});

// ---------- 查询 ----------
app.get('/api/punches', (req, res) => {
  const { bib } = req.query;
  const sql = `
    SELECT p.id, p.record_no, p.bib, r.name AS runner_name, p.point, p.seconds, p.kind,
           p.orig_point, p.orig_seconds,
           p.status, p.void_reason, p.created_at
    FROM punch p LEFT JOIN runner r ON r.bib = p.bib
    ${bib ? 'WHERE p.bib = ?' : ''}
    ORDER BY p.bib, p.seconds, p.id`;
  const punches = bib ? db.prepare(sql).all(bib) : db.prepare(sql).all();
  const auditRows = db.prepare(
    `SELECT a.* FROM punch_audit a JOIN punch p ON p.id = a.punch_id
     ${bib ? 'WHERE p.bib = ?' : ''} ORDER BY a.at, a.id`
  ).all(...(bib ? [bib] : []));
  const audits = auditRows.map((a) => ({
    id: a.id, punchId: a.punch_id, action: a.action, origPoint: a.orig_point, origSeconds: a.orig_seconds,
    newPoint: a.new_point, newSeconds: a.new_seconds, reason: a.reason, at: a.at,
  }));
  res.json({ punches, audits });
});

app.get('/api/results', (req, res) => {
  const cfg = loadConfig(db);
  if (!cfg) return res.json({ configured: false, results: [], groups: [], divisions: [], assignments: [] });
  const results = computeResults(db, cfg);
  res.json({
    configured: true,
    revision: cfg.revision,
    startPoint: cfg.start_point,
    finishPoint: cfg.finish_point,
    finishCutoff: cfg.finish_cutoff,
    groups: cfg.groups.map((g) => ({ name: g.name, seq: g.seq, cutoffSecs: g.cutoff_secs, points: g.points })),
    divisions: cfg.divisions.map(divisionView),
    assignments: assignmentsView(cfg),
    stoppages: cfg.stoppages.map((s) => ({ startSecs: s.start, endSecs: s.end })),
    results,
  });
});

// ---------- 裁判：作废 / 更正 ----------
function auditBody(req, res) {
  const { reason, newPoint, newSeconds } = req.body || {};
  if (typeof reason !== 'string' || !reason.trim()) {
    res.status(400).json({ error: '必须填写处理原因（留痕）' });
    return null;
  }
  return { reason: reason.trim(), newPoint, newSeconds };
}

app.post('/api/punches/:id/void', (req, res) => {
  const body = auditBody(req, res);
  if (!body) return;
  const p = db.prepare('SELECT * FROM punch WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '打卡不存在' });
  if (p.status === 'voided') return badRequest(res, '该打卡已作废');
  const revision = db.transaction(() => {
    db.prepare("UPDATE punch SET status = 'voided', void_reason = ? WHERE id = ?").run(body.reason, p.id);
    db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, reason)
       VALUES (?, 'void', ?, ?, ?)`
    ).run(p.id, p.point, p.seconds, body.reason);
    return bumpRevision(db);
  })();
  res.json({ ok: true, revision });
});

app.post('/api/punches/:id/correct', (req, res) => {
  const body = auditBody(req, res);
  if (!body) return;
  const p = db.prepare('SELECT * FROM punch WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '打卡不存在' });
  if (p.status === 'voided') return badRequest(res, '已作废打卡不能更正，请先确认数据来源');

  const newPoint = typeof body.newPoint === 'string' ? body.newPoint.trim() : null;
  const newSeconds = body.newSeconds;
  if (!newPoint) return badRequest(res, '更正后的点位必填');
  if (!Number.isInteger(newSeconds) || newSeconds < 0) return badRequest(res, '更正后的秒数须为非负整数');
  if (newPoint === p.point && newSeconds === p.seconds) return badRequest(res, '新值与现值相同，无需更正');

  const revision = db.transaction(() => {
    db.prepare('UPDATE punch SET point = ?, seconds = ? WHERE id = ?').run(newPoint, newSeconds, p.id);
    db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, new_point, new_seconds, reason)
       VALUES (?, 'correct', ?, ?, ?, ?, ?)`
    ).run(p.id, p.point, p.seconds, newPoint, newSeconds, body.reason);
    return bumpRevision(db);
  })();
  res.json({ ok: true, revision });
});

// ---------- 整案申诉：预演 + 确认（两阶段，原子落库） ----------
/**
 * POST /api/appeals/preview
 * body: { expectedRevision, operations: [{ punchId, action:'void'|'correct', reason, newPoint?, newSeconds? }] }
 * 只读预演：基于当前修订号展示处理前后所有受影响选手的成绩/名次/失败原因/有效链差异，
 * 不改动打卡、审计、修订号或任何历史发布版。返回签名 token 供确认绑定。
 */
app.post('/api/appeals/preview', (req, res) => {
  if (!checkRevision(req, res)) return;
  const cfg = loadConfig(db);
  if (!cfg) return badRequest(res, '赛事尚未配置');
  const v = validateOperations(db, req.body?.operations);
  if (v.error) return badRequest(res, v.error);
  const operations = canonicalOps(v.operations);

  const preview = previewCase(db, cfg, v.operations, v.targets);
  const token = signPreview(cfg.revision, operations);
  res.json({
    ok: true,
    revision: cfg.revision,
    token,
    operations,
    affectedCount: preview.affectedCount,
    affected: preview.affected,
  });
});

/**
 * POST /api/appeals/confirm
 * body: { expectedRevision, token }
 * 确认只绑定「预演时的修订号 + 预演的操作集合」（签名在 token 内）：
 *  - 赛事已变化（expectedRevision 过期）→ 409 + currentRevision，要求重新预演；
 *  - token 缺失/非法/服务重启后失效 → 400，要求重新预演；
 *  - token 修订与当前修订不一致 → 409 + currentRevision；
 *  - 再次整案校验（缺失打卡/已作废/重复等）失败 → 400 整案拒绝。
 * 通过后全部变更与逐条审计在一个事务内一次性落库，修订号只推进一次，
 * 返回最新成绩；任何失败均不会部分生效。
 */
app.post('/api/appeals/confirm', (req, res) => {
  const expectedRaw = req.body?.expectedRevision;
  const expected = Number(expectedRaw);
  if (expectedRaw == null || !Number.isInteger(expected) || expected < 0)
    return badRequest(res, '缺少 expectedRevision');
  const cur = currentRevision(db);
  if (expected !== cur)
    return res.status(409).json({ error: '赛事已修订，请重新预演后再确认', currentRevision: cur });

  const payload = verifyPreview(req.body?.token);
  if (!payload)
    return badRequest(res, '预演令牌无效或已过期（服务重启后），请重新预演整案');
  if (payload.revision !== cur)
    return res.status(409).json({ error: '赛事已修订，请重新预演后再确认', currentRevision: cur });

  const cfg = loadConfig(db);
  if (!cfg) return badRequest(res, '赛事尚未配置');
  // 确认时以令牌中的操作集合重新整案校验（数据可能已被他人改动）
  const v = validateOperations(db, payload.operations);
  if (v.error) return badRequest(res, v.error);

  const { revision, results } = commitCase(db, cfg, v.operations, v.targets);
  res.json({
    ok: true,
    revision,
    committed: canonicalOps(v.operations),
    auditCount: v.operations.length,
    results,
  });
});

// ---------- 发布（冻结） ----------
app.post('/api/publications', (req, res) => {
  if (!checkRevision(req, res)) return;
  const cfg = loadConfig(db);
  if (!cfg) return badRequest(res, '赛事尚未配置');
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : null;

  const result = db.transaction(() => {
    const versionRow = db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publication')
      .get();
    const version = versionRow.v;
    const results = computeResults(db, cfg);
    const readings = db
      .prepare(
        `SELECT p.record_no, p.bib, r.name AS runner_name, p.point, p.seconds, p.kind
         FROM punch p LEFT JOIN runner r ON r.bib = p.bib
         WHERE p.status = 'active' ORDER BY p.bib, p.seconds, p.id`
      )
      .all();
    const configJson = JSON.stringify({
      name: cfg.name, startPoint: cfg.start_point, finishPoint: cfg.finish_point,
      finishCutoff: cfg.finish_cutoff,
      groups: cfg.groups.map((g) => ({ seq: g.seq, name: g.name, cutoffSecs: g.cutoff_secs, points: g.points })),
    });
    // 冻结发布当时的停表区间并集；后续调整不改历史版
    const stoppages = cfg.stoppages.map((s) => ({ startSecs: s.start, endSecs: s.end }));
    const stoppagesJson = JSON.stringify(stoppages);
    // 冻结发布当时的组别赛道与选手归属；后续变更不改历史版
    const divisionsJson = JSON.stringify({
      divisions: cfg.divisions.map(divisionView),
      assignments: assignmentsView(cfg),
    });
    const readingsJson = JSON.stringify(readings);
    const resultsJson = JSON.stringify(results);
    db.prepare(
      `INSERT INTO publication (version, event_revision, note, config_json, stoppages_json, divisions_json, readings_json, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(version, cfg.revision, note, configJson, stoppagesJson, divisionsJson, readingsJson, resultsJson);
    const insR = db.prepare(
      `INSERT INTO published_result (publication_version, bib, name, status, elapsed, net_elapsed, fail_at, detail, rank_no, division_code, group_rank)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of results)
      insR.run(version, r.bib, r.name, r.status, r.elapsed, r.netElapsed ?? null, r.failAt ?? null, r.detail,
        r.rank ?? null, r.divisionCode ?? null, r.groupRank ?? null);
    // 发布本身冻结快照；继续推进修订号，使旧页面的导入/发布请求走过期核对
    const rev = bumpRevision(db);
    return { version, rev };
  })();
  res.json({ ok: true, version: result.version, revision: result.rev });
});

app.get('/api/publications', (req, res) => {
  const rows = db
    .prepare('SELECT version, event_revision, published_at, note FROM publication ORDER BY version DESC')
    .all();
  res.json({ publications: rows });
});

app.get('/api/publications/:version', (req, res) => {
  const v = Number(req.params.version);
  const row = db
    .prepare('SELECT * FROM publication WHERE version = ?')
    .get(v);
  if (!row) return res.status(404).json({ error: '发布版不存在' });
  res.json({
    version: row.version,
    eventRevision: row.event_revision,
    publishedAt: row.published_at,
    note: row.note,
    config: JSON.parse(row.config_json),
    stoppages: JSON.parse(row.stoppages_json || '[]'),
    // 冻结的组别赛道与归属（旧版发布时无组别，迁移回填为空集合）
    divisions: JSON.parse(row.divisions_json || '{"divisions":[],"assignments":[]}'),
    readings: JSON.parse(row.readings_json),
    results: JSON.parse(row.results_json),
  });
});

// ---------- 静态前端（生产容器） ----------
const distDir = process.env.WEB_DIST || join(__dirname, '..', '..', 'web', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.status(200).send('后端已启动；生产环境请先构建前端（web/dist），或使用 docker compose 一键启动。')
  );
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`定向越野复核系统已启动: http://localhost:${PORT}`);
});

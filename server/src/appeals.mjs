// 整案申诉：同一申诉可对多条现有打卡逐条指定作废或更正。
// 两阶段：
//   1) preview 基于当前赛事修订号在内存中预演整案（只读，绝不改库/审计/修订号）；
//   2) confirm 携带预演返回的 revision 与签名令牌，原子落库全部变更与逐条审计，
//      修订号只推进一次；任何失败整案拒绝，不部分生效。
// 令牌仅绑定「预演时修订号 + 规范化操作集合」，不落任何持久状态（预演因此完全只读）。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rankResults, computeRunnerFromReadings, computeResults } from './scoring.mjs';

// 每进程随机签名密钥：服务重启后旧预演令牌失效，需要重新预演（不会导致任何写入）。
const SECRET = randomBytes(32);

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function sign(payloadB64) {
  return b64url(createHmac('sha256', SECRET).update(payloadB64).digest());
}

/** 生成预演令牌：payload = { revision, operations: 规范化后的操作集合 } */
export function signPreview(revision, operations) {
  const body = b64url(JSON.stringify({ revision, operations }));
  return `${body}.${sign(body)}`;
}

/**
 * 校验令牌并还原 { revision, operations }。
 * 非法/被篡改/服务已重启 → null（调用方按 400「请重新预演」处理）。
 */
export function verifyPreview(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let expected;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload || !Number.isInteger(payload.revision) || !Array.isArray(payload.operations)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 解析并整案校验请求中的操作集合。
 * 成功返回 { operations, targets }；任一不合法返回 { error }（整案拒绝）。
 * 规则：
 *  - 非空数组；同一打卡（punchId）不得重复指定；
 *  - 每条操作 action=void|correct，且 reason 必填；
 *  - correct 必须给非空 newPoint 与非负整数 newSeconds，且不得与现值完全相同；
 *  - 目标打卡必须存在；已作废打卡不得更正，也不能再次作废。
 */
export function validateOperations(db, rawOps) {
  if (!Array.isArray(rawOps) || rawOps.length === 0)
    return { error: 'operations 须为非空数组（同一申诉至少一条处理）' };

  const operations = [];
  const seen = new Set();
  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i];
    const where = `第 ${i + 1} 条操作`;
    if (!op || typeof op !== 'object') return { error: `${where} 格式非法` };
    const punchId = Number(op.punchId);
    if (!Number.isInteger(punchId) || punchId <= 0) return { error: `${where}: punchId 必填` };
    if (seen.has(punchId)) return { error: `打卡 #${punchId} 在同一申诉中被重复指定，整案拒绝` };
    if (!['void', 'correct'].includes(op.action))
      return { error: `打卡 #${punchId}: action 须为 void 或 correct` };
    const reason = typeof op.reason === 'string' ? op.reason.trim() : '';
    if (!reason) return { error: `打卡 #${punchId}: 必须填写处理原因（留痕）` };

    const normalized = { punchId, action: op.action, reason };
    if (op.action === 'correct') {
      const newPoint = typeof op.newPoint === 'string' ? op.newPoint.trim() : '';
      const newSeconds = op.newSeconds;
      if (!newPoint) return { error: `打卡 #${punchId}: 更正后的点位必填` };
      if (!Number.isInteger(newSeconds) || newSeconds < 0)
        return { error: `打卡 #${punchId}: 更正后的秒数须为非负整数` };
      normalized.newPoint = newPoint;
      normalized.newSeconds = newSeconds;
    }
    seen.add(punchId);
    operations.push(normalized);
  }

  // 目标存在性 / 现状校验（缺失打卡或已作废 → 整案拒绝）
  const getPunch = db.prepare('SELECT * FROM punch WHERE id = ?');
  const targets = new Map();
  for (const op of operations) {
    const p = getPunch.get(op.punchId);
    if (!p) return { error: `打卡 #${op.punchId} 不存在，整案拒绝` };
    if (p.status === 'voided')
      return { error: `打卡 #${op.punchId}（${p.record_no}）已作废，不能再次处理，整案拒绝` };
    if (op.action === 'correct' && op.newPoint === p.point && op.newSeconds === p.seconds)
      return { error: `打卡 #${op.punchId}（${p.record_no}）新值与现值相同，无需更正，整案拒绝` };
    targets.set(p.id, p);
  }
  return { operations, targets };
}

/** 对外/入令牌使用的规范化操作集合（仅保留可序列化字段，顺序即提交顺序） */
export function canonicalOps(operations) {
  return operations.map((op) =>
    op.action === 'void'
      ? { punchId: op.punchId, action: 'void', reason: op.reason }
      : { punchId: op.punchId, action: 'correct', reason: op.reason, newPoint: op.newPoint, newSeconds: op.newSeconds }
  );
}

/** 读取全部选手及其当前有效读数（预演前的基线） */
function snapshotState(db) {
  const runners = db.prepare('SELECT bib, name FROM runner').all();
  const getReadings = db.prepare(
    `SELECT record_no, point, seconds, kind, bib FROM punch
      WHERE status = 'active' ORDER BY bib, seconds, id`
  );
  const byBib = new Map(runners.map((r) => [r.bib, { name: r.name, readings: [] }]));
  for (const p of getReadings.all()) {
    if (!byBib.has(p.bib)) byBib.set(p.bib, { name: null, readings: [] });
    byBib.get(p.bib).readings.push({ record_no: p.record_no, point: p.point, seconds: p.seconds, kind: p.kind });
  }
  return byBib;
}

/** 在内存快照上施加操作集合（不触碰数据库） */
function applyOpsVirtual(byBib, operations, targets) {
  const affectedBibs = new Set();
  for (const op of operations) {
    const p = targets.get(op.punchId);
    affectedBibs.add(p.bib);
    const entry = byBib.get(p.bib);
    if (!entry) continue;
    if (op.action === 'void') {
      entry.readings = entry.readings.filter((r) => r.record_no !== p.record_no);
    } else {
      const r = entry.readings.find((x) => x.record_no === p.record_no);
      if (r) { r.point = op.newPoint; r.seconds = op.newSeconds; }
    }
  }
  return affectedBibs;
}

function calcAll(byBib, config) {
  const results = [...byBib.entries()].map(([bib, e]) =>
    computeRunnerFromReadings(e.readings, config, bib, e.name)
  );
  return rankResults(results);
}

const slimResult = (r) => ({
  bib: r.bib,
  name: r.name ?? null,
  status: r.status,
  elapsed: r.elapsed ?? null,
  netElapsed: r.netElapsed ?? null,
  stoppedSecs: r.stoppedSecs ?? null,
  rank: r.rank ?? null,
  groupRank: r.groupRank ?? null,
  divisionCode: r.divisionCode ?? null,
  divisionName: r.divisionName ?? null,
  failAt: r.failAt ?? null,
  detail: r.detail ?? '',
  chain: r.chain,
});

const chainKey = (c) => `${c.kind}|${c.point}|${c.seconds}|${c.record_no}`;

function chainDiff(before, after) {
  const bKeys = new Set(before.map(chainKey));
  const aKeys = new Set(after.map(chainKey));
  return {
    removed: before.filter((c) => !aKeys.has(chainKey(c))),
    added: after.filter((c) => !bKeys.has(chainKey(c))),
  };
}

function resultChanged(a, b) {
  return (
    a.status !== b.status ||
    (a.elapsed ?? null) !== (b.elapsed ?? null) ||
    (a.netElapsed ?? null) !== (b.netElapsed ?? null) ||
    (a.rank ?? null) !== (b.rank ?? null) ||
    (a.groupRank ?? null) !== (b.groupRank ?? null) ||
    (a.failAt ?? null) !== (b.failAt ?? null) ||
    a.detail !== b.detail ||
    chainDiff(a.chain, b.chain).removed.length + chainDiff(a.chain, b.chain).added.length > 0
  );
}

/**
 * 预演整案：返回处理前/后成绩对比（含仅因他人变化而名次改变的选手）。
 * 只读：不修改打卡、审计、修订号与历史发布版。
 */
export function previewCase(db, config, operations, targets) {
  const byBib = snapshotState(db);
  const before = calcAll(byBib, config);
  const directBibs = applyOpsVirtual(byBib, operations, targets);
  const after = calcAll(byBib, config);

  const beforeMap = new Map(before.map((r) => [r.bib, r]));
  const affected = after
    .map((r) => {
      const b = beforeMap.get(r.bib);
      const changed = !b || resultChanged(b, r);
      return { after: r, before: b, changed, direct: directBibs.has(r.bib) };
    })
    .filter((x) => x.direct || x.changed)
    .sort((x, y) => x.after.bib.localeCompare(y.after.bib));

  return {
    revision: config.revision,
    affectedCount: affected.length,
    affected: affected.map(({ after: a, before: b, changed, direct }) => ({
      bib: a.bib,
      name: a.name ?? null,
      direct,
      changed,
      chainDiff: chainDiff(b ? b.chain : [], a.chain),
      before: b ? slimResult(b) : null,
      after: slimResult(a),
    })),
  };
}

/**
 * 确认落库：整案在单个事务内生效——
 * 逐条写打卡变更与审计，修订号只推进一次。任一步骤抛错则整体回滚。
 * 返回新修订号与全部选手最新成绩。
 */
export function commitCase(db, config, operations, targets) {
  const tx = db.transaction(() => {
    const voidStmt = db.prepare("UPDATE punch SET status = 'voided', void_reason = ? WHERE id = ?");
    const correctStmt = db.prepare('UPDATE punch SET point = ?, seconds = ? WHERE id = ?');
    const auditVoid = db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, reason)
       VALUES (?, 'void', ?, ?, ?)`
    );
    const auditCorrect = db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, new_point, new_seconds, reason)
       VALUES (?, 'correct', ?, ?, ?, ?, ?)`
    );
    for (const op of operations) {
      const p = targets.get(op.punchId);
      if (op.action === 'void') {
        voidStmt.run(op.reason, p.id);
        auditVoid.run(p.id, p.point, p.seconds, op.reason);
      } else {
        correctStmt.run(op.newPoint, op.newSeconds, p.id);
        auditCorrect.run(p.id, p.point, p.seconds, op.newPoint, op.newSeconds, op.reason);
      }
    }
    const revision = db
      .prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision')
      .get().revision;
    return revision;
  });
  const revision = tx();

  const freshConfig = { ...config, revision };
  return { revision, results: computeResults(db, freshConfig) };
}

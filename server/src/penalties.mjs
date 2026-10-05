// 罚时裁决：裁判可批量登记或撤销选手的罚时裁决。
//   登记：{ action:'register', rulingNo（唯一裁决号）, bib（已有号码布）, seconds（正整数秒）, reason }
//   撤销：{ action:'register' 相反 } -> { action:'revoke', rulingNo, reason }
// 规则：
//  - 整批原子：批内重复裁决号、未知选手、未知裁决、内容冲突、非法秒数等任一非法
//    => 整批拒绝（400），不写入任何一条裁决或审计；
//  - 幂等：同号同内容的有效裁决重传（register 已存在且 bib/秒数/原因一致）、
//    已撤销裁决同原因重撤均为只读，不留痕、不推进修订；
//  - 撤销后裁决号不可复用（登记一个已撤销号码仍是冲突，整批拒绝）；
//  - 实际变更（新登记 / 新撤销）在一个事务内一次性落库并逐条写审计，修订号只推进一次。
import { loadActivePenalties } from './scoring.mjs';

/**
 * 规范化并整批校验裁决操作。
 * 成功返回 { ops, effectiveChanges }，其中：
 *   ops —— 规范化后的操作（register/revoke，字段已 trim）；
 *   effectiveChanges —— 真正会产生变更的操作（幂等跳过的不计入）。
 * 任一非法返回 { error }（整批拒绝，不部分写入/留痕）。
 *
 * 校验分两遍，先批内（未知选手等不查库的规则），再对库：批内冲突必须先暴露，
 * 避免「先到先得」式地把同号操作与库内状态比对后给出误导性结果。
 */
export function validatePenaltyOps(db, rawOps) {
  if (!Array.isArray(rawOps) || rawOps.length === 0)
    return { error: 'ops 须为非空数组（每批至少一条登记或撤销）' };

  const ops = [];
  const inBatch = new Set();
  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i];
    const where = `第 ${i + 1} 条`;
    if (!op || typeof op !== 'object') return { error: `${where} 格式非法，整批拒绝` };
    const action = op.action;
    if (!['register', 'revoke'].includes(action))
      return { error: `${where}: action 须为 register 或 revoke，整批拒绝` };
    const rulingNo = typeof op.rulingNo === 'string' ? op.rulingNo.trim() : '';
    if (!rulingNo) return { error: `${where}: 裁决号必填，整批拒绝` };
    const reason = typeof op.reason === 'string' ? op.reason.trim() : '';
    if (!reason) return { error: `裁决 ${rulingNo || `（${where}）`}: 必须填写原因（留痕），整批拒绝` };

    // 批内重复裁决号 => 整批拒绝（无论内容是否相同；幂等只针对跨请求重传）
    if (inBatch.has(rulingNo))
      return { error: `裁决号 ${rulingNo} 在批次内重复，整批拒绝` };
    inBatch.add(rulingNo);

    const normalized = { action, rulingNo, reason };
    if (action === 'register') {
      const bib = typeof op.bib === 'string' ? op.bib.trim() : '';
      if (!bib) return { error: `裁决 ${rulingNo}: 号码布必填，整批拒绝` };
      const seconds = op.seconds;
      if (!Number.isInteger(seconds) || seconds <= 0)
        return { error: `裁决 ${rulingNo}: 罚时秒数须为正整数，整批拒绝` };
      normalized.bib = bib;
      normalized.seconds = seconds;
    }
    ops.push(normalized);
  }

  // 对库校验 + 判定幂等：未知选手 / 未知裁决 / 内容冲突 / 撤销后复用均整批拒绝。
  const runnerExists = db.prepare('SELECT 1 FROM runner WHERE bib = ?');
  const getRuling = db.prepare('SELECT * FROM penalty_ruling WHERE ruling_no = ?');
  // 同一裁决号在批内只可能出现一次（上方已拒），因此每条操作都以库中现状为基准即可。
  const effectiveChanges = [];
  for (const op of ops) {
    const row = getRuling.get(op.rulingNo);
    if (op.action === 'register') {
      if (!runnerExists.get(op.bib))
        return { error: `裁决 ${op.rulingNo}: 未知选手（号码布 ${op.bib} 不存在），整批拒绝` };
      if (row) {
        if (row.status === 'revoked')
          return { error: `裁决号 ${op.rulingNo} 已撤销，号码不可复用，整批拒绝` };
        // 已有有效裁决：内容完全一致 => 幂等只读；任一字段不同 => 内容冲突
        if (row.bib !== op.bib || row.seconds !== op.seconds || row.reason !== op.reason)
          return { error: `裁决号 ${op.rulingNo} 已存在且内容冲突，整批拒绝` };
        // 同号同内容重传：幂等跳过（不留痕、不推进修订）
        continue;
      }
    } else {
      if (!row) return { error: `裁决号 ${op.rulingNo} 不存在，整批拒绝` };
      if (row.status === 'revoked') {
        // 已撤销裁决同原因重撤 => 幂等只读；原因不同 => 冲突
        if ((row.revoke_reason || '') !== op.reason)
          return { error: `裁决号 ${op.rulingNo} 已撤销且撤销原因冲突，整批拒绝` };
        continue;
      }
      // 撤销有效裁决：撤销记录自身原因必填（上方已校验）；原裁决内容不变。
    }
    effectiveChanges.push(op);
  }
  return { ops, effectiveChanges };
}

/**
 * 提交一批裁决：全部变更与逐条审计在一个事务内一次性落库，修订号只推进一次。
 * 调用方须已通过 validatePenaltyOps；effectiveChanges 为空时为只读（直接返回当前修订）。
 * 返回 { revision, changed, registered, revoked, rulings }。
 */
export function commitPenaltyOps(db, ops, effectiveChanges) {
  let revision = currentRev(db);
  let registered = 0;
  let revoked = 0;
  if (effectiveChanges.length > 0) {
    revision = db.transaction(() => {
      const insRuling = db.prepare(
        'INSERT INTO penalty_ruling (ruling_no, bib, seconds, reason, status) VALUES (?, ?, ?, ?, ?)'
      );
      const doRevoke = db.prepare(
        "UPDATE penalty_ruling SET status = 'revoked', revoke_reason = ?, revoked_at = datetime('now') WHERE ruling_no = ? AND status = 'active'"
      );
      const insAudit = db.prepare(
        `INSERT INTO penalty_audit (ruling_no, action, bib, seconds, reason, revoke_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const op of effectiveChanges) {
        if (op.action === 'register') {
          insRuling.run(op.rulingNo, op.bib, op.seconds, op.reason, 'active');
          insAudit.run(op.rulingNo, 'register', op.bib, op.seconds, op.reason, null);
          registered++;
        } else {
          const before = db.prepare('SELECT bib, seconds, reason FROM penalty_ruling WHERE ruling_no = ?').get(op.rulingNo);
          const r = doRevoke.run(op.reason, op.rulingNo);
          if (r.changes === 0) throw new Error(`裁决 ${op.rulingNo} 在提交时已非有效状态，整批回滚`);
          insAudit.run(op.rulingNo, 'revoke', before.bib, before.seconds, before.reason, op.reason);
          revoked++;
        }
      }
      return bumpRev(db);
    })();
  }
  return { revision, changed: effectiveChanges.length > 0, registered, revoked, rulings: listRulings(db) };
}

// 事务内直接使用的修订号助手（避免与 db.mjs 循环依赖：动态读取 prepare）
function currentRev(db) {
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  return row ? row.revision : 0;
}
function bumpRev(db) {
  return db.prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision').get().revision;
}

/** 裁决对外形态 */
function rulingView(r) {
  return {
    rulingNo: r.ruling_no,
    bib: r.bib,
    name: r.runner_name ?? null,
    seconds: r.seconds,
    reason: r.reason,
    status: r.status,
    revokeReason: r.revoke_reason ?? null,
    createdAt: r.created_at,
    revokedAt: r.revoked_at ?? null,
  };
}

/** 全部裁决（有效在前、已撤销在后，各按登记次序）+ 逐条审计 + 每人有效罚时合计 */
export function listRulings(db) {
  const rows = db
    .prepare(
      `SELECT r.*, rn.name AS runner_name FROM penalty_ruling r
       LEFT JOIN runner rn ON rn.bib = r.bib
       ORDER BY r.status = 'revoked', r.id`
    )
    .all();
  const audits = db
    .prepare('SELECT id, ruling_no, action, bib, seconds, reason, revoke_reason, at FROM penalty_audit ORDER BY id')
    .all()
    .map((a) => ({
      id: a.id, rulingNo: a.ruling_no, action: a.action, bib: a.bib, seconds: a.seconds,
      reason: a.reason, revokeReason: a.revoke_reason ?? null, at: a.at,
    }));
  const totals = {};
  for (const [bib, list] of Object.entries(loadActivePenalties(db)))
    totals[bib] = list.reduce((n, p) => n + p.seconds, 0);
  return { rulings: rows.map(rulingView), audits, totals };
}

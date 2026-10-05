// 裁判罚时裁决：批量登记 / 撤销，整批原子生效。
//  - 登记 entry：{ decisionNo, bib, seconds（正整数）, reason }；
//  - 撤销 entry：{ decisionNo, reason }。
// 整批规则（任一不满足 → 整批拒绝，不写任何裁决/审计）：
//  - 裁决号非空；批内同一裁决号重复出现时：内容完全一致 → 幂等去重，内容冲突 → 整批拒绝；
//    同一裁决号不得在一批中既登记又撤销；
//  - 登记：秒数为正整数、原因必填；号码布必须是已有选手（runner 表）；
//    裁决号若已存在：有效且内容（号码布/秒数/原因）完全一致 → 幂等重传；
//    已撤销（裁决号不可复用）或内容冲突 → 整批拒绝；
//  - 撤销：原因必填；裁决号必须存在：已撤销且撤销原因一致 → 幂等重撤；
//    不存在 / 已撤销但原因不同 → 整批拒绝。
// 实际变化（非幂等条目）在单个事务内逐条落库并逐条审计，修订号只推进一次；
// 全部条目均幂等时为只读操作，不推进修订号。

/** 对外/审计统一形态 */
export function penaltyView(p) {
  return {
    decisionNo: p.decision_no,
    bib: p.bib,
    seconds: p.seconds,
    reason: p.reason,
    status: p.status, // active | revoked
    revokeReason: p.revoke_reason ?? null,
    createdAt: p.created_at,
    revokedAt: p.revoked_at ?? null,
  };
}

/**
 * 规范化并整批校验。成功返回
 * { entries: [{ action:'register'|'revoke', decisionNo, bib?, seconds?, reason }] }。
 * 仅做与库无关的格式/批内校验（未知选手/未知裁决等库内校验在 applyPenaltyBatch 内完成）。
 */
export function normalizePenaltyEntries(rawEntries) {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0)
    return { error: 'entries 须为非空数组（每批至少一条登记或撤销）' };

  const entries = [];
  const byNo = new Map(); // decisionNo -> 已规范化条目（批内幂等去重/冲突检测）
  const keyOf = (e) =>
    e.action === 'register'
      ? `register|${e.bib}|${e.seconds}|${e.reason}`
      : `revoke|${e.reason}`;

  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    const where = `第 ${i + 1} 条裁决`;
    if (!e || typeof e !== 'object') return { error: `${where} 格式非法，整批拒绝` };
    const decisionNo = typeof e.decisionNo === 'string' ? e.decisionNo.trim() : '';
    if (!decisionNo) return { error: `${where}：裁决号必填，整批拒绝` };
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (!reason) return { error: `裁决 ${decisionNo}：原因必填（留痕），整批拒绝` };

    const action = e.action;
    let entry;
    if (action === 'register') {
      const bib = typeof e.bib === 'string' ? e.bib.trim() : '';
      if (!bib) return { error: `裁决 ${decisionNo}：号码布必填，整批拒绝` };
      const seconds = e.seconds;
      if (!Number.isInteger(seconds) || seconds <= 0)
        return { error: `裁决 ${decisionNo}：罚时秒数须为正整数，整批拒绝` };
      entry = { action, decisionNo, bib, seconds, reason };
    } else if (action === 'revoke') {
      entry = { action, decisionNo, reason };
    } else {
      return { error: `裁决 ${decisionNo}：action 须为 register 或 revoke，整批拒绝` };
    }

    const prev = byNo.get(decisionNo);
    if (prev) {
      // 同号又登记又撤销，或同动作但内容不同 → 批内冲突
      if (prev.action !== entry.action || keyOf(prev) !== keyOf(entry))
        return { error: `裁决 ${decisionNo} 在批次内重复且内容冲突，整批拒绝` };
      continue; // 完全一致 → 批内幂等去重
    }
    byNo.set(decisionNo, entry);
    entries.push(entry);
  }
  return { entries };
}

/**
 * 库内校验 + 事务提交。
 * 幂等（无变化）条目跳过；其余 register/revoke 在一个事务内落库并逐条写审计，
 * 修订号只推进一次。任一库内校验失败抛出 Error（含「，整批拒绝」文案），事务不开启即拒绝。
 * 返回 { revision, registered, revoked, idempotent, decisions }。
 */
export function applyPenaltyBatch(db, entries, bumpRevision) {
  const getPenalty = db.prepare('SELECT * FROM penalty WHERE decision_no = ?');
  const getRunner = db.prepare('SELECT bib FROM runner WHERE bib = ?');

  // 先做全部库内校验（任何失败都在写事务之前返回，绝不部分留痕）
  const pending = [];
  let idempotent = 0;
  for (const e of entries) {
    const p = getPenalty.get(e.decisionNo);
    if (e.action === 'register') {
      if (!getRunner.get(e.bib))
        throw new Error(`裁决 ${e.decisionNo}：未知号码布 ${e.bib}（选手不存在），整批拒绝`);
      if (p) {
        if (p.status === 'revoked')
          throw new Error(`裁决号 ${e.decisionNo} 已撤销，编号不可复用，整批拒绝`);
        // 有效裁决重传：号码布/秒数/原因完全一致才幂等
        if (p.bib !== e.bib || p.seconds !== e.seconds || p.reason !== e.reason)
          throw new Error(`裁决号 ${e.decisionNo} 已存在且内容冲突，整批拒绝`);
        idempotent++;
        continue;
      }
    } else {
      if (!p) throw new Error(`裁决号 ${e.decisionNo} 不存在，整批拒绝`);
      if (p.status === 'revoked') {
        if (p.revoke_reason !== e.reason)
          throw new Error(`裁决号 ${e.decisionNo} 已撤销且撤销原因冲突，整批拒绝`);
        idempotent++; // 已撤销裁决同原因重撤：幂等
        continue;
      }
    }
    pending.push(e);
  }

  let revision = null;
  if (pending.length > 0) {
    revision = db.transaction((items) => {
      const insP = db.prepare(
        'INSERT INTO penalty (decision_no, bib, seconds, reason, status) VALUES (?, ?, ?, ?, \'active\')'
      );
      const insAudit = db.prepare(
        'INSERT INTO penalty_audit (penalty_id, action, seconds, reason) VALUES (?, ?, ?, ?)'
      );
      const doRevoke = db.prepare(
        "UPDATE penalty SET status = 'revoked', revoke_reason = ?, revoked_at = datetime('now') WHERE id = ?"
      );
      for (const e of items) {
        if (e.action === 'register') {
          const id = insP.run(e.decisionNo, e.bib, e.seconds, e.reason).lastInsertRowid;
          insAudit.run(id, 'register', e.seconds, e.reason);
        } else {
          const cur = getPenalty.get(e.decisionNo);
          doRevoke.run(e.reason, cur.id);
          insAudit.run(cur.id, 'revoke', null, e.reason);
        }
      }
      return bumpRevision(db);
    })(pending);
  }

  // 汇总本批每条裁决的最终状态（按提交次序）
  const decisions = entries.map((e) => penaltyView(getPenalty.get(e.decisionNo)));
  const registered = pending.filter((e) => e.action === 'register').length;
  const revoked = pending.filter((e) => e.action === 'revoke').length;
  return { revision, registered, revoked, idempotent, decisions };
}

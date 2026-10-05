import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

/**
 * 罚时裁决：批量登记 / 撤销。
 * - 登记：唯一裁决号 + 已有号码布 + 正整数秒数 + 原因；
 * - 撤销：裁决号 + 原因；
 * 批内重复、未知选手/裁决、内容冲突、非法秒数整批拒绝（不写任何留痕）；
 * 同号同内容的有效裁决重传、已撤销同原因重撤幂等；撤销后号码不可复用。
 * 实际变更原子落库、只推进一次修订号。
 */
export default function Penalties({ event, onChanged, onError }) {
  const [data, setData] = useState(null);
  const [ops, setOps] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.penalties().then(setData).catch(() => setData(null));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const addOp = action =>
    setOps(os => [...os, {
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action, rulingNo: '', bib: '', seconds: '', reason: '',
    }]);
  const patch = (localId, p) => setOps(os => os.map(o => (o.localId === localId ? { ...o, ...p } : o)));
  const remove = localId => setOps(os => os.filter(o => o.localId !== localId));
  const setResultBox = r => { setResult(r); setTimeout(() => setResult(null), 4000); };

  // 客户端即时校验（与后端整批拒绝文案一致）
  const errors = useMemo(() => {
    const errs = [];
    const seen = new Set();
    ops.forEach((o, i) => {
      const where = `第 ${i + 1} 条`;
      if (!o.rulingNo.trim()) return errs.push(`${where}：裁决号必填`);
      if (seen.has(o.rulingNo.trim())) return errs.push(`裁决号 ${o.rulingNo.trim()} 在批次内重复`);
      seen.add(o.rulingNo.trim());
      if (!o.reason.trim()) return errs.push(`裁决 ${o.rulingNo.trim()}：必须填写原因（留痕）`);
      if (o.action === 'register') {
        if (!o.bib.trim()) return errs.push(`裁决 ${o.rulingNo.trim()}：号码布必填`);
        const s = Number(o.seconds);
        if (!Number.isInteger(s) || s <= 0) return errs.push(`裁决 ${o.rulingNo.trim()}：罚时秒数须为正整数`);
      }
    });
    return errs;
  }, [ops]);

  const submit = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (ops.length === 0) return onError(new Error('请先添加至少一条登记或撤销'));
    if (errors.length) return onError(new Error(`${errors[0]}，整批拒绝`));
    setBusy(true);
    try {
      const r = await api.submitPenalties({
        expectedRevision: event.revision,
        ops: ops.map(o =>
          o.action === 'register'
            ? { action: 'register', rulingNo: o.rulingNo.trim(), bib: o.bib.trim(), seconds: Number(o.seconds), reason: o.reason.trim() }
            : { action: 'revoke', rulingNo: o.rulingNo.trim(), reason: o.reason.trim() }),
      });
      if (r.changed) {
        setOps([]);
        setResultBox({ ok: true, text: `已提交：登记 ${r.registered} 条、撤销 ${r.revoked} 条（修订 #${r.revision}）` });
      } else {
        setResultBox({ ok: true, text: `全部为幂等重传（${r.idempotent} 条），未留痕、修订号不变（#${r.revision}）` });
      }
      await onChanged();
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const quickRevoke = (r) =>
    setOps(os => [...os, {
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action: 'revoke', rulingNo: r.rulingNo, bib: r.bib, seconds: String(r.seconds), reason: '',
    }]);

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  const rulings = data?.rulings || [];
  const audits = data?.audits || [];
  const totals = data?.totals || {};

  return (
    <div className="panel">
      <h2>罚时裁决（批量登记 / 撤销）</h2>
      <p className="muted small">
        裁判对选手加罚正整数秒：<b>正式耗时 officialElapsed = 净耗时 + 有效罚时合计</b>，
        <b>rank / groupRank 按正式耗时允许并列</b>；未完赛者名次仍为空（罚时列出但不产生正式耗时，
        一旦后续经申诉完赛即计入），原始耗时 elapsed / 净耗时 netElapsed 含义不变。
        每批须携带当前修订号；<b>批内重复裁决号、未知选手/裁决、内容冲突、非法秒数整批拒绝</b>，不留部分审计；
        同号同内容的有效裁决重传、已撤销裁决同原因重撤<b>幂等</b>；<b>撤销后裁决号不可复用</b>。
        实际变更原子落库并只推进一次修订号；发布版冻结裁决、正式耗时与名次，后续撤销不改历史。
      </p>

      <h3>本批操作（{ops.length} 条）</h3>
      <table className="grid compact">
        <thead>
          <tr><th style={{ width: 70 }}>#</th><th style={{ width: 110 }}>操作</th><th>裁决号（唯一）</th><th>号码布</th><th>罚时秒数（正整数）</th><th className="grow-input">原因（必填，永久留痕）</th><th></th></tr>
        </thead>
        <tbody>
          {ops.map((o, i) => (
            <tr key={o.localId} className="edit-row">
              <td>{i + 1}</td>
              <td>
                <select value={o.action} onChange={e => patch(o.localId, { action: e.target.value })}>
                  <option value="register">登记</option>
                  <option value="revoke">撤销</option>
                </select>
              </td>
              <td><input value={o.rulingNo} onChange={e => patch(o.localId, { rulingNo: e.target.value })} placeholder="如 P-2026-001" style={{ width: 150 }} /></td>
              <td>
                {o.action === 'register'
                  ? <input value={o.bib} onChange={e => patch(o.localId, { bib: e.target.value })} placeholder="已有号码布" style={{ width: 100 }} />
                  : <span className="muted small">按裁决号撤销</span>}
              </td>
              <td>
                {o.action === 'register'
                  ? <input type="number" min="1" step="1" value={o.seconds} onChange={e => patch(o.localId, { seconds: e.target.value })} style={{ width: 110 }} />
                  : <span className="muted small">—</span>}
              </td>
              <td><input className="grow-input" value={o.reason} onChange={e => patch(o.localId, { reason: e.target.value })} placeholder="如：漏打强制点，依据终点裁判记录" /></td>
              <td><button className="btn small danger" onClick={() => remove(o.localId)}>移除</button></td>
            </tr>
          ))}
          {ops.length === 0 && (
            <tr><td colSpan="7" className="muted">尚未添加操作。整批可混合登记与撤销；核对无误后一次提交（原子生效）。</td></tr>
          )}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn" onClick={() => addOp('register')}>+ 登记罚时</button>
        <button className="btn" onClick={() => addOp('revoke')}>+ 撤销裁决</button>
        <button className="btn primary" disabled={busy || ops.length === 0} onClick={submit}>
          整批提交（基于修订 #{event?.revision ?? '—'}）
        </button>
        {result && <span className={result.ok ? 'ok-text' : ''}>{result.text}</span>}
      </div>
      {errors.length > 0 && (
        <ul className="rules" style={{ color: '#c62828' }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      <h3>当前裁决（{rulings.length} 条）· 实时修订 #{data?.revision ?? '—'}</h3>
      <table className="grid compact">
        <thead>
          <tr><th>裁决号</th><th>号码布</th><th>姓名</th><th>罚时</th><th>状态</th><th>登记原因</th><th>撤销原因 / 时间</th><th></th></tr>
        </thead>
        <tbody>
          {rulings.map(r => (
            <tr key={r.rulingNo} className={r.status === 'revoked' ? 'row-void' : ''}>
              <td>{r.rulingNo}</td>
              <td>{r.bib}</td>
              <td>{r.name || '—'}</td>
              <td>+{r.seconds}s（{fmtTime(r.seconds)}）</td>
              <td>
                {r.status === 'active'
                  ? <span className="badge warn">有效 · 计入 {totals[r.bib] ?? 0}s</span>
                  : <span className="badge bad">已撤销</span>}
              </td>
              <td className="small">{r.reason}<div className="muted small">{r.createdAt}</div></td>
              <td className="small muted">{r.status === 'revoked' ? `${r.revokeReason || '—'} · ${r.revokedAt || ''}` : '—'}</td>
              <td>
                {r.status === 'active' && (
                  <button className="btn small danger" onClick={() => quickRevoke(r)}>加入撤销</button>
                )}
              </td>
            </tr>
          ))}
          {rulings.length === 0 && <tr><td colSpan="8" className="muted">暂无裁决。</td></tr>}
        </tbody>
      </table>

      <h3>裁决留痕（{audits.length} 条）</h3>
      <table className="grid compact">
        <thead><tr><th>时间(UTC)</th><th>裁决号</th><th>动作</th><th>号码布</th><th>秒数</th><th>原因</th><th>撤销原因</th></tr></thead>
        <tbody>
          {audits.map(a => (
            <tr key={a.id} className="audit-row">
              <td className="small muted">{a.at}</td>
              <td>{a.rulingNo}</td>
              <td><span className={`badge ${a.action === 'register' ? 'warn' : 'bad'}`}>{a.action === 'register' ? '登记' : '撤销'}</span></td>
              <td>{a.bib}</td>
              <td>{a.seconds != null ? `+${a.seconds}s` : '—'}</td>
              <td className="small">{a.reason}</td>
              <td className="small muted">{a.revokeReason || '—'}</td>
            </tr>
          ))}
          {audits.length === 0 && <tr><td colSpan="7" className="muted">暂无留痕。</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

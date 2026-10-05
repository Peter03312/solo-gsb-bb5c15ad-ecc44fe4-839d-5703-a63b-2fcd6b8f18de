import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

const EMPTY_REGISTER = () => ({ decisionNo: '', bib: '', seconds: '', reason: '' });
const EMPTY_REVOKE = () => ({ decisionNo: '', reason: '' });

/** 罚时裁决：批量登记 / 撤销，整批原子、幂等重传/重撤 */
export default function Penalties({ event, onChanged, onError }) {
  const [registers, setRegisters] = useState([EMPTY_REGISTER()]);
  const [revokes, setRevokes] = useState([EMPTY_REVOKE()]);
  const [data, setData] = useState(null);
  const [runners, setRunners] = useState([]);
  const [bibFilter, setBibFilter] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.penalties(bibFilter || undefined).then(setData).catch(() => setData(null));
  }, [bibFilter]);

  const loadAll = useCallback(async () => {
    load();
    try {
      const rs = await api.results();
      setRunners((rs.results || []).map(r => ({ bib: r.bib, name: r.name })));
    } catch { /* 未配置 */ }
  }, [load]);

  useEffect(() => { if (event?.configured) loadAll(); }, [event, loadAll]);

  const knownBibs = useMemo(() => new Set(runners.map(r => r.bib)), [runners]);

  const setReg = (i, patch) => setRegisters(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setRev = (i, patch) => setRevokes(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** 客户端即时校验（后端整批校验兜底）；同时标记空行（空行提交时自动剔除） */
  const filledRegisters = registers.filter(r => r.decisionNo.trim() || r.bib.trim() || r.seconds.trim() || r.reason.trim());
  const filledRevokes = revokes.filter(r => r.decisionNo.trim() || r.reason.trim());

  const errors = useMemo(() => {
    const errs = [];
    const seen = new Map();
    const flag = (no, msg) => errs.push(`裁决 ${no || '（空号）'}：${msg}`);
    for (const r of filledRegisters) {
      const no = r.decisionNo.trim();
      if (!no) { flag('', '裁决号必填'); continue; }
      if (!r.bib.trim()) flag(no, '号码布必填');
      else if (!knownBibs.has(r.bib.trim())) flag(no, `号码布 ${r.bib.trim()} 不存在（须为已有选手）`);
      const s = Number(r.seconds);
      if (r.seconds.trim() === '' || !Number.isInteger(s) || s <= 0) flag(no, '罚时秒数须为正整数');
      if (!r.reason.trim()) flag(no, '原因必填（永久留痕）');
      if (seen.has(no)) errs.push(`裁决 ${no} 在批次内重复（同内容重传将幂等处理，内容冲突整批拒绝）`);
      seen.set(no, 'register');
    }
    for (const r of filledRevokes) {
      const no = r.decisionNo.trim();
      if (!no) { errs.push('撤销条目：裁决号必填'); continue; }
      if (!r.reason.trim()) flag(no, '撤销原因必填（永久留痕）');
      if (seen.has(no)) errs.push(`裁决 ${no} 在同一批中既登记又撤销，整批拒绝`);
      seen.set(no, 'revoke');
    }
    return errs;
  }, [filledRegisters, filledRevokes, knownBibs]);

  const submit = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    const entries = [
      ...filledRegisters.map(r => ({
        action: 'register', decisionNo: r.decisionNo.trim(), bib: r.bib.trim(),
        seconds: Number(r.seconds), reason: r.reason.trim(),
      })),
      ...filledRevokes.map(r => ({ action: 'revoke', decisionNo: r.decisionNo.trim(), reason: r.reason.trim() })),
    ];
    if (entries.length === 0) return onError(new Error('请先填写至少一条登记或撤销'));
    if (errors.length) return onError(new Error(`${errors[0]}，整批拒绝`));
    if (!window.confirm(
      `本批共 ${entries.length} 条（登记 ${filledRegisters.length}、撤销 ${filledRevokes.length}）。\n` +
      '非法条目会整批拒绝且不留任何审计；实际变更原子落库，修订号只推进一次。确认提交？'
    )) return;
    setBusy(true);
    try {
      const r = await api.penaltyBatch({ expectedRevision: event.revision, entries });
      setResult(r);
      if (r.changed) {
        setRegisters([EMPTY_REGISTER()]);
        setRevokes([EMPTY_REVOKE()]);
      }
      await onChanged();
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const auditsByPenalty = useMemo(() => {
    const m = new Map();
    for (const a of data?.audits || []) {
      if (!m.has(a.penaltyId)) m.set(a.penaltyId, []);
      m.get(a.penaltyId).push(a);
    }
    return m;
  }, [data]);

  // 已有裁决号 -> 裁决（用于客户端提示编号不可复用/内容冲突）
  const existingByNo = useMemo(() => {
    const m = new Map();
    for (const p of data?.penalties || []) m.set(p.decisionNo, p);
    return m;
  }, [data]);

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  return (
    <div className="panel">
      <h2>裁判罚时裁决（批量登记 / 撤销）</h2>
      <p className="muted small">
        完赛者的<b>正式耗时 officialElapsed = 净耗时 netElapsed + 有效罚时合计</b>，
        <b>rank / groupRank 按正式耗时计算并允许并列</b>；未完赛者名次仍为空，罚时照常留痕。
        每条登记含<b>唯一裁决号、已有号码布、正整数秒数、原因</b>；撤销含<b>裁决号与原因</b>。
        <b>批内重复/冲突、未知选手或裁决、撤销编号复用、非法秒数整批拒绝，不留部分审计</b>；
        同号同内容的有效裁决重传、已撤销裁决同原因重撤均<b>幂等</b>（不推进修订），撤销后裁决号不可复用。
        请求须带 <b>expectedRevision</b>，过期返回当前修订号；实际变更原子留痕且只推进一次修订。
        <b>发布版冻结裁决、正式耗时与名次，后续撤销不改历史。</b>
      </p>

      <h3>批量登记罚时</h3>
      <table className="grid compact">
        <thead><tr><th style={{ width: 40 }}>#</th><th>裁决号（唯一）</th><th>号码布</th><th>秒数（正整数）</th><th>原因（永久留痕）</th><th></th></tr></thead>
        <tbody>
          {registers.map((r, i) => {
            const ex = r.decisionNo.trim() ? existingByNo.get(r.decisionNo.trim()) : null;
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <input value={r.decisionNo} onChange={e => setReg(i, { decisionNo: e.target.value })} placeholder="如：P-2026-001" style={{ width: 150 }} />
                  {ex && (
                    <div className="small muted">
                      {ex.status === 'revoked'
                        ? <span style={{ color: '#a80707' }}>该号已撤销，不可复用</span>
                        : <>库中已有：{ex.bib} +{ex.seconds}s{
                          (r.bib.trim() && r.bib.trim() !== ex.bib) ||
                          (r.seconds.trim() && Number(r.seconds) !== ex.seconds) ||
                          (r.reason.trim() && r.reason.trim() !== ex.reason)
                            ? '（内容不一致将整批拒绝）' : '（同内容重传幂等）'
                        }</>}
                    </div>
                  )}
                </td>
                <td>
                  <input value={r.bib} onChange={e => setReg(i, { bib: e.target.value })} placeholder="号码布" style={{ width: 100 }}
                    list="penalty-bibs" />
                </td>
                <td><input type="number" min="1" step="1" value={r.seconds} onChange={e => setReg(i, { seconds: e.target.value })} style={{ width: 110 }} /></td>
                <td><input className="grow-input" value={r.reason} onChange={e => setReg(i, { reason: e.target.value })} placeholder="如：未按规定方向通过补给点" /></td>
                <td><button className="btn small danger" onClick={() => setRegisters(rs => rs.filter((_, j) => j !== i))}>删除</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="btn small" onClick={() => setRegisters(rs => [...rs, EMPTY_REGISTER()])}>+ 添加登记</button>

      <datalist id="penalty-bibs">
        {runners.map(r => <option key={r.bib} value={r.bib}>{r.name}</option>)}
      </datalist>

      <h3>批量撤销裁决</h3>
      <table className="grid compact">
        <thead><tr><th style={{ width: 40 }}>#</th><th>裁决号</th><th>撤销原因（永久留痕）</th><th></th></tr></thead>
        <tbody>
          {revokes.map((r, i) => {
            const ex = r.decisionNo.trim() ? existingByNo.get(r.decisionNo.trim()) : null;
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <input value={r.decisionNo} onChange={e => setRev(i, { decisionNo: e.target.value })} placeholder="要撤销的裁决号" style={{ width: 180 }} />
                  {ex && (
                    <div className="small muted">
                      {ex.status === 'active'
                        ? <>当前有效：{ex.bib} +{ex.seconds}s（{ex.reason}）</>
                        : <span style={{ color: '#a80707' }}>已撤销（同原因重撤幂等，异因拒绝）</span>}
                    </div>
                  )}
                </td>
                <td><input className="grow-input" value={r.reason} onChange={e => setRev(i, { reason: e.target.value })} placeholder="如：申诉成立，依据监控撤销" /></td>
                <td><button className="btn small danger" onClick={() => setRevokes(rs => rs.filter((_, j) => j !== i))}>删除</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="btn small" onClick={() => setRevokes(rs => [...rs, EMPTY_REVOKE()])}>+ 添加撤销</button>

      {errors.length > 0 && (
        <ul className="rules" style={{ color: '#c62828' }}>
          {errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
          {errors.length > 6 && <li>…另有 {errors.length - 6} 项问题</li>}
        </ul>
      )}

      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={submit}>
          整批提交（登记 {filledRegisters.length} / 撤销 {filledRevokes.length}，基于修订 #{event?.revision ?? '—'}）
        </button>
        {result && (
          <span className="small muted">
            上一批：新登记 {result.registered}、新撤销 {result.revoked}、幂等 {result.idempotent}，
            {result.changed ? <>已推进至修订 #{result.revision}</> : <>无变化，修订 #{result.revision} 不变</>}
          </span>
        )}
      </div>

      <h3>裁决登记册{data?.penalties?.length ? `（${data.penalties.length} 条）` : ''}</h3>
      <div className="filter">
        <input placeholder="按号码布筛选（留空显示全部）" value={bibFilter} onChange={e => setBibFilter(e.target.value)} />
        <button className="btn" onClick={load}>查询</button>
      </div>
      <table className="grid compact">
        <thead>
          <tr><th>裁决号</th><th>号码布</th><th>罚时</th><th>登记原因</th><th>状态</th><th>撤销原因 / 留痕</th></tr>
        </thead>
        <tbody>
          {(data?.penalties || []).slice().reverse().map(p => (
            <React.Fragment key={p.decisionNo}>
              <tr className={p.status === 'revoked' ? 'row-void' : ''}>
                <td>{p.decisionNo}</td>
                <td>{p.bib}</td>
                <td>+{p.seconds}s（{fmtTime(p.seconds)}）</td>
                <td>{p.reason}<div className="muted small">登记 {p.createdAt}</div></td>
                <td>
                  {p.status === 'active'
                    ? <span className="badge ok">有效</span>
                    : <span className="badge bad">已撤销</span>}
                </td>
                <td>
                  {p.status === 'revoked'
                    ? <>{p.revokeReason}<div className="muted small">撤销 {p.revokedAt}</div></>
                    : <span className="muted small">—</span>}
                </td>
              </tr>
              {(auditsByPenalty.get(p.id) || []).map(a => (
                <tr key={a.id} className="audit-row">
                  <td colSpan="6">
                    <span className={`badge ${a.action === 'register' ? 'warn' : 'bad'}`}>
                      {a.action === 'register' ? '登记记录' : '撤销记录'}
                    </span>
                    {a.action === 'register' ? ` 判罚 +${a.seconds}s` : ' 罚时撤销（不再计入正式耗时，编号不可复用）'}
                    <span className="muted"> 原因：{a.reason} · {a.at}</span>
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
          {(data?.penalties || []).length === 0 && (
            <tr><td colSpan="6" className="muted">暂无裁决记录{bibFilter ? `（号码布 ${bibFilter}）` : ''}。</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

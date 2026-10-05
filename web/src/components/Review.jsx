import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

const KIND_LABEL = { start: '出发', enroute: '途中', finish: '终点' };

export default function Review({ event, onChanged, onError }) {
  const [data, setData] = useState(null);
  const [bib, setBib] = useState('');
  const [editing, setEditing] = useState(null); // {id, mode:'void'|'correct'}
  const [reason, setReason] = useState('');
  const [newPoint, setNewPoint] = useState('');
  const [newSeconds, setNewSeconds] = useState('');

  const load = useCallback(() => {
    api.punches(bib || undefined).then(setData).catch(() => setData(null));
  }, [bib]);

  useEffect(() => { load(); }, [load]);

  const auditsByPunch = useMemo(() => {
    const m = new Map();
    (data?.audits || []).forEach(a => {
      if (!m.has(a.punchId)) m.set(a.punchId, []);
      m.get(a.punchId).push(a);
    });
    return m;
  }, [data]);

  const byBib = useMemo(() => {
    const m = new Map();
    for (const p of data?.punches || []) {
      if (!m.has(p.bib)) m.set(p.bib, { name: p.runner_name, punches: [] });
      m.get(p.bib).punches.push(p);
    }
    return [...m.entries()];
  }, [data]);

  const submit = async p => {
    try {
      if (editing.mode === 'void') {
        await api.voidPunch(p.id, reason);
      } else {
        await api.correctPunch(p.id, { reason, newPoint: newPoint.trim(), newSeconds: Number(newSeconds) });
      }
      setEditing(null); setReason('');
      await onChanged();
      load();
    } catch (err) {
      onError(err);
    }
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  return (
    <div className="panel">
      <h2>裁判争议复核</h2>
      <p className="muted small">
        作废：该读数不再参与有效链；更正：以新点位/秒数重算成绩。两类操作均<b>保留原值与原因</b>，
        且立即重算当前成绩（已发布的历史版不受影响）。更正/作废后重新导入原始批次时，
        系统按<b>首次入库的原始读数</b>识别同号记录并幂等跳过，不会覆盖现值与留痕；
        表格中以「原始点位/原始秒数」标注初始读数。
      </p>
      <div className="filter">
        <input placeholder="按号码布筛选（留空显示全部）" value={bib} onChange={e => setBib(e.target.value)} />
        <button className="btn" onClick={load}>查询</button>
      </div>

      {byBib.map(([b, info]) => (
        <div key={b} className="bib-block">
          <h3>{b} · {info.name || '未命名'}</h3>
          <table className="grid compact">
            <thead>
              <tr><th>记录号</th><th>类型</th><th>点位</th><th>距发枪秒数</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              {info.punches.map(p => {
                const isEditing = editing?.id === p.id;
                return (
                  <React.Fragment key={p.id}>
                    <tr className={p.status === 'voided' ? 'row-void' : ''}>
                      <td>{p.record_no}</td>
                      <td>{KIND_LABEL[p.kind]}</td>
                      <td>
                        {p.point}
                        {p.orig_point && p.orig_point !== p.point && (
                          <div className="muted small">原始点位：{p.orig_point}</div>
                        )}
                      </td>
                      <td>
                        {p.seconds}s（{fmtTime(p.seconds)}）
                        {p.orig_seconds != null && p.orig_seconds !== p.seconds && (
                          <div className="muted small">原始秒数：{p.orig_seconds}s</div>
                        )}
                      </td>
                      <td>
                        {p.status === 'voided'
                          ? <span className="badge bad">已作废</span>
                          : <span className="badge ok">有效</span>}
                        {p.void_reason && <div className="muted small">原因：{p.void_reason}</div>}
                      </td>
                      <td>
                        {p.status === 'active' && !isEditing && (
                          <>
                            <button className="btn small" onClick={() => { setEditing({ id: p.id, mode: 'correct' }); setNewPoint(p.point); setNewSeconds(p.seconds); setReason(''); }}>更正</button>
                            <button className="btn small danger" onClick={() => { setEditing({ id: p.id, mode: 'void' }); setReason(''); }}>作废</button>
                          </>
                        )}
                      </td>
                    </tr>
                    {isEditing && (
                      <tr className="edit-row">
                        <td colSpan="6">
                          {editing.mode === 'correct' && (
                            <div className="inline-fields">
                              <label>新点位 <input value={newPoint} onChange={e => setNewPoint(e.target.value)} /></label>
                              <label>新秒数 <input type="number" min="0" value={newSeconds} onChange={e => setNewSeconds(e.target.value)} /></label>
                            </div>
                          )}
                          <div className="inline-fields">
                            <label className="grow">原因（必填，永久留痕）<input value={reason} onChange={e => setReason(e.target.value)} placeholder="如：记录笔误，依据申诉照片更正" /></label>
                            <button className="btn primary" onClick={() => submit(p)}>确认{editing.mode === 'void' ? '作废' : '更正'}并重算</button>
                            <button className="btn" onClick={() => setEditing(null)}>取消</button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {(auditsByPunch.get(p.id) || []).map(a => (
                      <tr key={a.id} className="audit-row">
                        <td colSpan="6">
                          <span className={`badge ${a.action === 'void' ? 'bad' : 'warn'}`}>
                            {a.action === 'void' ? '作废记录' : '更正记录'}
                          </span>
                          {a.action === 'correct' ? (
                            <>原值 {a.orig_point}@{a.orig_seconds}s → {a.newPoint}@{a.newSeconds}s</>
                          ) : (
                            <>原值 {a.orig_point}@{a.orig_seconds}s 作废</>
                          )}
                          <span className="muted"> 原因：{a.reason} · {a.at}</span>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {byBib.length === 0 && <p className="muted">暂无打卡记录。</p>}
    </div>
  );
}

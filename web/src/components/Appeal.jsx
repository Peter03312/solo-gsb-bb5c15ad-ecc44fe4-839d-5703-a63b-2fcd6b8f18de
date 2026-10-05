import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

const KIND_LABEL = { start: '出发', enroute: '途中', finish: '终点' };

const STATUS_LABEL = {
  ok: '完成', group_dnf: '组未完成', finish_dnf: '终点超时',
  no_start: '无出发', bad_start: '出发异常',
};
const STATUS_CLS = { ok: 'ok', group_dnf: 'dnf', finish_dnf: 'dnf', no_start: 'bad', bad_start: 'bad' };

/** 有效链片段（复用成绩页 chip 样式） */
function Chain({ chain }) {
  return (
    <span className="chain">
      {chain.map((c, i) => (
        <React.Fragment key={`${c.record_no}-${i}`}>
          {i > 0 && <span className="arrow">→</span>}
          <span className="chip" title={`记录号 ${c.record_no}`}>{c.point}<small>{c.seconds}s</small></span>
        </React.Fragment>
      ))}
      {chain.length === 0 && <span className="muted small">（无有效链）</span>}
    </span>
  );
}

function RankCell({ r }) {
  if (!r) return '—';
  const st = STATUS_LABEL[r.status] || r.status;
  return (
    <div>
      <span className={`badge ${STATUS_CLS[r.status] || 'bad'}`}>{st}</span>
      <div className="small muted">
        名次 {r.rank ?? '—'} · 组内 {r.groupRank ?? '—'}
        {r.divisionCode ? `（${r.divisionCode}）` : ''}
      </div>
      {r.elapsed != null ? (
        <>
          <div className="small">原始 {r.elapsed}s{r.stoppedSecs ? `（停表 −${r.stoppedSecs}s）` : ''}</div>
          <div className="small"><b>净耗时 {r.netElapsed ?? r.elapsed}s（{fmtTime(r.netElapsed ?? r.elapsed)}）</b></div>
        </>
      ) : <div className="small">—</div>}
    </div>
  );
}

export default function Appeal({ event, onChanged, onError }) {
  const [bib, setBib] = useState('');
  const [data, setData] = useState(null);
  // 草稿操作：{ localId, punchId, recordNo, action, reason, newPoint, newSeconds }
  const [drafts, setDrafts] = useState([]);
  const [preview, setPreview] = useState(null);
  const [confirmResult, setConfirmResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.punches(bib || undefined).then(setData).catch(() => setData(null));
  }, [bib]);
  useEffect(() => { load(); }, [load]);

  // 被整案选中的打卡 id 集合（同一条打卡不得重复指定）
  const chosenIds = useMemo(() => new Set(drafts.map(d => d.punchId)), [drafts]);

  // 任何草稿改动都会使旧预演失效（必须重新预演后才能确认）
  const invalidate = () => { setPreview(null); setConfirmResult(null); };

  const byBib = useMemo(() => {
    const m = new Map();
    for (const p of data?.punches || []) {
      if (!m.has(p.bib)) m.set(p.bib, { name: p.runner_name, punches: [] });
      m.get(p.bib).punches.push(p);
    }
    return [...m.entries()];
  }, [data]);

  const addDraft = (p, action) => {
    if (chosenIds.has(p.id)) return;
    setDrafts(ds => [...ds, {
      localId: `${p.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      punchId: p.id,
      recordNo: p.record_no,
      action,
      reason: '',
      newPoint: p.point,
      newSeconds: String(p.seconds),
    }]);
    invalidate();
  };
  const patchDraft = (localId, patch) =>
    setDrafts(ds => ds.map(d => (d.localId === localId ? { ...d, ...patch } : d)));
  const removeDraft = localId => { setDrafts(ds => ds.filter(d => d.localId !== localId)); invalidate(); };

  const buildOperations = () =>
    drafts.map(d => {
      const op = { punchId: d.punchId, action: d.action, reason: d.reason };
      if (d.action === 'correct') { op.newPoint = d.newPoint.trim(); op.newSeconds = Number(d.newSeconds); }
      return op;
    });

  const doPreview = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (drafts.length === 0) return onError(new Error('请先添加至少一条处理操作'));
    setBusy(true);
    try {
      const r = await api.appealPreview({ expectedRevision: event.revision, operations: buildOperations() });
      setPreview(r);
      setConfirmResult(null);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (!preview) return;
    const summary = preview.operations
      .map(o => `#${o.punchId} ${o.action === 'void' ? '作废' : `更正→${o.newPoint}@${o.newSeconds}s`}`)
      .join('；');
    if (!window.confirm(`将一次性提交整案 ${preview.operations.length} 条处理（${summary}），修订号只推进一次且不可撤销。确认？`)) return;
    setBusy(true);
    try {
      const r = await api.appealConfirm({ expectedRevision: preview.revision, token: preview.token });
      setConfirmResult(r);
      setDrafts([]);
      setPreview(null);
      await onChanged();
      load();
    } catch (err) {
      if (err.status === 409) setPreview(null); // 赛事已变化，旧预演失效
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  return (
    <div className="panel">
      <h2>整案申诉复核</h2>
      <p className="muted small">
        同一申诉可对<b>多条现有打卡</b>逐条指定处理：<b>作废</b>（填原因）或<b>更正</b>（填原因、新点位、非负整数秒数）。
        已作废打卡不能再处理，同一打卡在一个整案中只能指定一次。提交前系统基于<b>当前修订号 #{event.revision}</b>
        <b>预演整案</b>（只读，不改库），展示处理前后所有受影响选手——包括仅因他人成绩变化而<b>名次改变</b>的选手——
        的成绩、名次、失败原因与有效链差异。确认时绑定预演的修订号与操作集合，一次性原子落库全部变更与逐条审计，
        修订号只推进一次；赛事被他人改动则需重新预演。
      </p>

      <div className="filter">
        <input placeholder="按号码布筛选待处理打卡（留空显示全部）" value={bib} onChange={e => setBib(e.target.value)} />
        <button className="btn" onClick={load}>查询</button>
      </div>

      {byBib.map(([b, info]) => (
        <div key={b} className="bib-block">
          <h3>{b} · {info.name || '未命名'}</h3>
          <table className="grid compact">
            <thead>
              <tr><th>记录号</th><th>类型</th><th>点位</th><th>秒数</th><th>状态</th><th>加入整案</th></tr>
            </thead>
            <tbody>
              {info.punches.map(p => (
                <tr key={p.id} className={p.status === 'voided' ? 'row-void' : ''}>
                  <td>{p.record_no}</td>
                  <td>{KIND_LABEL[p.kind]}</td>
                  <td>
                    {p.point}
                    {p.orig_point && p.orig_point !== p.point && (
                      <div className="muted small">原始：{p.orig_point}</div>
                    )}
                  </td>
                  <td>{p.seconds}s<div className="muted small">{fmtTime(p.seconds)}</div></td>
                  <td>
                    {p.status === 'voided'
                      ? <span className="badge bad">已作废</span>
                      : <span className="badge ok">有效</span>}
                  </td>
                  <td>
                    {p.status === 'active' && (
                      chosenIds.has(p.id)
                        ? <span className="badge warn">已加入本案</span>
                        : (
                          <>
                            <button className="btn small" onClick={() => addDraft(p, 'correct')}>更正</button>
                            <button className="btn small danger" onClick={() => addDraft(p, 'void')}>作废</button>
                          </>
                        )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {byBib.length === 0 && <p className="muted">暂无打卡记录。</p>}

      <h3>本案操作（{drafts.length} 条）</h3>
      {drafts.length === 0 && <p className="muted small">尚未添加操作。在上方打卡行点击「更正 / 作废」加入整案。</p>}
      <table className="grid compact">
        <thead>
          <tr><th>记录号</th><th>处理</th><th>新点位 / 秒数</th><th>原因（必填，永久留痕）</th><th></th></tr>
        </thead>
        <tbody>
          {drafts.map(d => (
            <tr key={d.localId}>
              <td>{d.recordNo}<div className="muted small">punch #{d.punchId}</div></td>
              <td>
                <span className={`badge ${d.action === 'void' ? 'bad' : 'warn'}`}>
                  {d.action === 'void' ? '作废' : '更正'}
                </span>
              </td>
              <td>
                {d.action === 'correct' ? (
                  <div className="inline-fields">
                    <input value={d.newPoint} onChange={e => { patchDraft(d.localId, { newPoint: e.target.value }); invalidate(); }}
                      placeholder="新点位" style={{ width: 90 }} />
                    <input type="number" min="0" value={d.newSeconds}
                      onChange={e => { patchDraft(d.localId, { newSeconds: e.target.value }); invalidate(); }}
                      style={{ width: 110 }} />
                  </div>
                ) : <span className="muted small">作废后不参与核算</span>}
              </td>
              <td>
                <input className="grow-input" value={d.reason}
                  onChange={e => { patchDraft(d.localId, { reason: e.target.value }); invalidate(); }}
                  placeholder="如：依据现场监控/成绩单，申诉成立" />
              </td>
              <td><button className="btn small danger" onClick={() => removeDraft(d.localId)}>移除</button></td>
          </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn primary" disabled={busy || drafts.length === 0} onClick={doPreview}>
          基于修订 #{event?.revision ?? '—'} 预演整案
        </button>
        <button className="btn primary" disabled={busy || !preview} onClick={doConfirm}>
          确认提交整案{preview ? `（绑定修订 #${preview.revision}）` : '（需先预演）'}
        </button>
      </div>

      {preview && (
        <div className="preview-box">
          <h3>预演结果（只读，未落库）· 修订 #{preview.revision}</h3>
          <p className="muted small">
            共 {preview.operations.length} 条操作，影响 {preview.affectedCount} 名选手；
            其中 <span className="badge warn">直接处理</span> 为被操作打卡所属选手，
            <span className="badge ok">名次联动</span> 为自身数据未变、仅因他人变化而名次改变的选手。
          </p>
          <table className="grid compact">
            <thead>
              <tr>
                <th>号码布</th><th>姓名</th><th>类别</th>
                <th style={{ width: 150 }}>处理前</th><th style={{ width: 150 }}>处理后</th>
                <th>处理前有效链</th><th>处理后有效链</th>
              </tr>
            </thead>
            <tbody>
              {preview.affected.map(a => (
                <tr key={a.bib} className={a.direct ? 'row-direct' : 'row-linked'}>
                  <td>{a.bib}</td>
                  <td>{a.name || '—'}</td>
                  <td>
                    {a.direct && <span className="badge warn">直接处理</span>}
                    {!a.direct && <span className="badge ok">名次联动</span>}
                    {!a.changed && <div className="muted small">成绩无变化</div>}
                  </td>
                  <td>
                    <RankCell r={a.before} />
                    {a.before?.failAt && <div className="small muted">{a.before.failAt}：{a.before.detail}</div>}
                  </td>
                  <td>
                    <RankCell r={a.after} />
                    {a.after?.failAt && <div className="small muted">{a.after.failAt}：{a.after.detail}</div>}
                  </td>
                  <td><Chain chain={a.before?.chain || []} /></td>
                  <td>
                    <Chain chain={a.after?.chain || []} />
                    {a.chainDiff.removed.length > 0 && (
                      <div className="small" style={{ color: '#c62828' }}>移出：{a.chainDiff.removed.map(c => `${c.point}@${c.seconds}s`).join('，')}</div>
                    )}
                    {a.chainDiff.added.length > 0 && (
                      <div className="small" style={{ color: '#1b6b32' }}>纳入：{a.chainDiff.added.map(c => `${c.point}@${c.seconds}s`).join('，')}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">核对无误后点击上方「确认提交整案」；若赛事被他人改动，确认将返回 409 并要求重新预演。</p>
        </div>
      )}

      {confirmResult && (
        <div className="preview-box">
          <h3>✅ 整案已确认落库 · 新修订 #{confirmResult.revision}</h3>
          <p className="muted small">
            {confirmResult.auditCount} 条变更及逐条审计已一次性写入（事务原子提交，无部分生效）；历史发布版保持冻结。
          </p>
          <table className="grid compact">
            <thead><tr><th>名次</th><th>组内名次</th><th>号码布</th><th>姓名</th><th>状态</th><th>原始耗时</th><th>净耗时</th><th>说明</th></tr></thead>
            <tbody>
              {confirmResult.results.map(r => (
                <tr key={r.bib} className={r.status === 'ok' ? '' : 'row-dnf'}>
                  <td>{r.rank ?? '—'}</td>
                  <td>{r.groupRank ?? '—'}</td>
                  <td>{r.bib}</td>
                  <td>{r.name || '—'}</td>
                  <td><span className={`badge ${STATUS_CLS[r.status] || 'bad'}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                  <td>{r.elapsed != null ? `${r.elapsed}s（${fmtTime(r.elapsed)}）` : '—'}</td>
                  <td>{r.netElapsed != null ? <b>{`${r.netElapsed}s（${fmtTime(r.netElapsed)}）`}</b> : '—'}</td>
                  <td className="small muted">{r.failAt ? `${r.failAt}：${r.detail}` : r.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

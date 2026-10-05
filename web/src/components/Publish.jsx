import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

const STATUS_LABEL = {
  ok: '完成', group_dnf: '组未完成', finish_dnf: '终点超时',
  no_start: '无出发', bad_start: '出发异常',
};

export default function Publish({ event, onChanged, onError }) {
  const [list, setList] = useState([]);
  const [note, setNote] = useState('');
  const [viewing, setViewing] = useState(null);

  const loadList = () => api.publications().then(d => setList(d.publications));
  useEffect(() => { loadList(); }, []);

  const doPublish = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (!window.confirm('发布将冻结当前关卡、有效读数与成绩；后续更正不会修改历史版。确认发布？')) return;
    try {
      const r = await api.publish({ expectedRevision: event.revision, note });
      setNote('');
      await onChanged();
      await loadList();
      openVersion(r.version);
    } catch (err) {
      onError(err);
    }
  };

  const openVersion = async v => {
    try { setViewing(await api.publication(v)); } catch (err) { onError(err); }
  };

  return (
    <div className="panel">
      <h2>发布与冻结</h2>
      <p className="muted small">
        发布时将关卡配置、组别赛道与选手归属、停表区间、全部有效读数（作废读数除外）及当次成绩
        （含全场名次与组内名次）一并快照冻结；发布后裁判仍可更正当前数据并发布新版，但<b>历史版本永不改变</b>。
      </p>
      <div className="inline-fields">
        <label className="grow">版本备注（可选）<input value={note} onChange={e => setNote(e.target.value)} placeholder="如：申诉处理后第二版" /></label>
        <button className="btn primary" onClick={doPublish}>发布新版本（修订 #{event?.revision ?? '—'}）</button>
      </div>

      <h3>历史版本</h3>
      <table className="grid compact">
        <thead><tr><th>版本</th><th>发布时间(UTC)</th><th>基于修订</th><th>备注</th><th></th></tr></thead>
        <tbody>
          {list.map(p => (
            <tr key={p.version}>
              <td>v{p.version}</td>
              <td>{p.published_at}</td>
              <td>#{p.event_revision}</td>
              <td>{p.note || '—'}</td>
              <td><button className="btn small" onClick={() => openVersion(p.version)}>查看冻结版</button></td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan="5" className="muted">尚未发布</td></tr>}
        </tbody>
      </table>

      {viewing && (
        <div className="snapshot">
          <h3>冻结版 v{viewing.version} <button className="btn small" onClick={() => setViewing(null)}>关闭</button></h3>
          <p className="muted small">
            发布于 {viewing.publishedAt}，基于修订 #{viewing.eventRevision} · {viewing.note || '无备注'}
          </p>
          <div className="snap-columns">
            <div>
              <h4>冻结关卡（{viewing.config.name}）</h4>
              <ul className="muted small">
                <li>起点 {viewing.config.startPoint} → 终点 {viewing.config.finishPoint}，终点截止 {viewing.config.finishCutoff}s</li>
                {viewing.config.groups.map(g => (
                  <li key={g.seq}>第 {g.seq} 组 {g.name}（{g.cutoffSecs == null ? '无组截止' : `截止 ${g.cutoffSecs}s`}）：{g.points.join(' / ')}</li>
                ))}
                <li>
                  冻结停表区间：
                  {(viewing.stoppages || []).length === 0
                    ? '无'
                    : viewing.stoppages.map(s => `${s.startSecs}s–${s.endSecs}s`).join('，')}
                </li>
              </ul>
              <h4>冻结组别赛道与归属</h4>
              {(viewing.divisions?.divisions || []).length === 0 ? (
                <p className="muted small">无组别：发布时全部选手沿用默认赛道。</p>
              ) : (
                <>
                  <ul className="muted small">
                    {viewing.divisions.divisions.map(d => (
                      <li key={d.code}>
                        <b>{d.code}</b> {d.name}（终点截止 {d.finishCutoff}s）：
                        {d.groups.map(g => `${g.name}[${g.points.join('/')}]${g.cutoffSecs == null ? '' : ` ≤${g.cutoffSecs}s`}`).join(' → ')}
                      </li>
                    ))}
                  </ul>
                  <div className="readings">
                    {(viewing.divisions.assignments || []).map(a => (
                      <span className="chip" key={a.bib}>{a.bib}<small>{a.divisionCode}</small></span>
                    ))}
                    {(viewing.divisions.assignments || []).length === 0 && (
                      <span className="muted small">无归属记录</span>
                    )}
                  </div>
                </>
              )}
              <h4>冻结有效读数（{viewing.readings.length} 条）</h4>
              <div className="readings">
                {viewing.readings.map(r => (
                  <span className="chip" key={r.record_no}>{r.bib} {r.point}<small>{r.seconds}s</small></span>
                ))}
              </div>
            </div>
            <div>
              <h4>冻结成绩（全场名次按冻结停表区间的净耗时；组内名次为同组完赛者排名）</h4>
              <table className="grid compact">
                <thead><tr><th>名次</th><th>组内名次</th><th>号码</th><th>组别</th><th>状态</th><th>原始耗时</th><th>净耗时</th><th>说明</th></tr></thead>
                <tbody>
                  {viewing.results.map(r => (
                    <tr key={r.bib}>
                      <td>{r.rank ?? '—'}</td>
                      <td>{r.groupRank ?? '—'}</td>
                      <td>{r.bib}</td>
                      <td>{r.divisionCode || <span className="muted small">未分组</span>}</td>
                      <td>{STATUS_LABEL[r.status] || r.status}</td>
                      <td>{r.elapsed != null ? `${fmtTime(r.elapsed)}（${r.elapsed}s）` : '—'}</td>
                      <td>{r.netElapsed != null ? <b>{`${fmtTime(r.netElapsed)}（${r.netElapsed}s）`}</b> : '—'}</td>
                      <td className="small muted">{r.detail}{r.failAt ? `（${r.failAt}）` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

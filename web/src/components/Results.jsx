import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export function fmtTime(secs) {
  if (secs == null) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const STATUS_LABEL = {
  ok: { text: '完成', cls: 'ok' },
  group_dnf: { text: '组未完成', cls: 'dnf' },
  finish_dnf: { text: '终点超时', cls: 'dnf' },
  no_start: { text: '无出发', cls: 'bad' },
  bad_start: { text: '出发异常', cls: 'bad' },
};

export default function Results() {
  const [data, setData] = useState(null);
  // 组别筛选：'all' 全部 | 'default' 未分组（默认赛道） | 组别代码
  const [divFilter, setDivFilter] = useState('all');

  useEffect(() => {
    const load = () => api.results().then(setData).catch(() => setData(null));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return <p className="muted">加载中…</p>;
  if (!data.configured) return <p className="muted">赛事尚未配置，请先到「关卡设置」建立关卡组与截止秒数。</p>;

  const divisions = data.divisions || [];
  const rows = (data.results || []).filter(r =>
    divFilter === 'all' ? true
      : divFilter === 'default' ? r.divisionCode == null
        : r.divisionCode === divFilter);

  return (
    <div>
      <p className="muted">
        起点 <b>{data.startPoint}</b> · 终点 <b>{data.finishPoint}</b> · 终点截止{' '}
        <b>{data.finishCutoff}s（{fmtTime(data.finishCutoff)}）</b> · 实时修订 #{data.revision}
      </p>
      <p className="muted small">
        统一停表（按并集只计一次）：
        {(data.stoppages || []).length === 0 ? (
          <b>无</b>
        ) : (
          data.stoppages.map((s, i) => (
            <span className="chip" key={i} style={{ marginLeft: 4 }}>
              {s.startSecs}s–{s.endSecs}s<small>{s.endSecs - s.startSecs}s</small>
            </span>
          ))
        )}
        ；排名与并列按<b>净耗时</b>，关卡/终点截止与有效链仍按原始秒数判定。
      </p>
      <p className="muted small">
        组别赛道：
        {divisions.length === 0 ? (
          <b>未设组别，全部选手走默认赛道</b>
        ) : (
          divisions.map(d => (
            <span className="chip" key={d.code} style={{ marginLeft: 4 }}
              title={`${d.groups.map(g => `${g.name}[${g.points.join('/')}]${g.cutoffSecs == null ? '' : ` ≤${g.cutoffSecs}s`}`).join(' → ')}`}>
              {d.code} {d.name}<small>{d.groups.length} 组关卡 · 终点 ≤{d.finishCutoff}s</small>
            </span>
          ))
        )}
        ；未分组者沿用默认赛道。<b>名次</b>为全场净耗时名次，<b>组内名次</b>只在同组完赛者中计算（允许并列），未完赛者两种名次均为空。
      </p>
      <div className="filter">
        <label className="muted small" style={{ alignSelf: 'center' }}>按组别查看：</label>
        <select value={divFilter} onChange={e => setDivFilter(e.target.value)}>
          <option value="all">全部赛道（{data.results.length} 人）</option>
          <option value="default">未分组 · 默认赛道</option>
          {divisions.map(d => (
            <option key={d.code} value={d.code}>{d.code} {d.name}</option>
          ))}
        </select>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>名次</th><th>组内名次</th><th>号码布</th><th>姓名</th><th>组别</th><th>状态</th>
            <th>原始耗时</th><th>停表扣减</th><th>净耗时</th>
            <th>首个未完成 / 说明</th><th className="chain-col">最早有效链</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const st = STATUS_LABEL[r.status] || { text: r.status, cls: 'bad' };
            return (
              <tr key={r.bib} className={r.status === 'ok' ? '' : 'row-dnf'}>
                <td>{r.rank ?? '—'}</td>
                <td>{r.groupRank ?? '—'}</td>
                <td>{r.bib}</td>
                <td>{r.name || '—'}</td>
                <td>
                  {r.divisionCode
                    ? <span className="chip">{r.divisionCode}<small>{r.divisionName}</small></span>
                    : <span className="muted small">未分组</span>}
                </td>
                <td><span className={`badge ${st.cls}`}>{st.text}</span></td>
                <td>{r.elapsed != null ? `${fmtTime(r.elapsed)}（${r.elapsed}s）` : '—'}</td>
                <td>{r.stoppedSecs ? `${r.stoppedSecs}s` : (r.status === 'ok' ? '0s' : '—')}</td>
                <td>
                  {r.netElapsed != null
                    ? <b>{`${fmtTime(r.netElapsed)}（${r.netElapsed}s）`}</b>
                    : <span className="muted">未完赛无净耗时</span>}
                </td>
                <td>{r.failAt ? <><b>{r.failAt}</b>：{r.detail}</> : r.detail || '—'}</td>
                <td className="chain">
                  {r.chain.map((c, i) => (
                    <React.Fragment key={c.record_no}>
                      {i > 0 && <span className="arrow">→</span>}
                      <span className="chip" title={`记录号 ${c.record_no}，${c.seconds}s`}>
                        {c.point}<small>{c.seconds}s</small>
                      </span>
                    </React.Fragment>
                  ))}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan="11" className="muted">该筛选下暂无选手。</td></tr>
          )}
        </tbody>
      </table>
      <p className="muted small">
        规则：打卡时间相对发枪秒数须严格递增，按所属赛道关卡组顺序每组在可替代点位中选最早一条；
        逆序及多余打卡不作完成依据。净耗时 = 原始耗时 − 停表区间并集与本人出发→终点区间的交长，
        同净耗时并列同名次；原始耗时（elapsed）语义不变。组内名次仅在同一赛道（同组别；未分组者同属默认赛道）
        的完赛者之间按净耗时计算，允许并列。
      </p>
    </div>
  );
}

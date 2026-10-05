import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

/** 合并重叠/相邻区间（与后端 mergeIntervals 同规则），用于保存前预览 */
function mergeIntervals(list) {
  const ivs = list
    .filter(x => Number.isInteger(x.start) && Number.isInteger(x.end))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const out = [];
  for (const iv of ivs) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export default function Stoppages({ event, onChanged, onError }) {
  // 草稿：{ start: string, end: string }
  const [rows, setRows] = useState([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (event?.configured) {
      setRows((event.stoppages || []).map(s => ({ start: String(s.startSecs), end: String(s.endSecs) })));
    }
  }, [event]);

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** 客户端即时校验，错误信息与后端 400 文案保持一致 */
  const errors = useMemo(() => {
    const errs = [];
    rows.forEach((r, i) => {
      const s = Number(r.start);
      const e = Number(r.end);
      if (r.start.trim() === '' || r.end.trim() === '' || !Number.isInteger(s) || !Number.isInteger(e))
        return errs.push(`第 ${i + 1} 个区间：起止秒数须为非负整数`);
      if (s < 0 || e < 0) return errs.push(`第 ${i + 1} 个区间：起止秒数不能为负`);
      if (s >= e) return errs.push(`第 ${i + 1} 个区间：起点（${s}）必须小于终点（${e}）`);
    });
    return errs;
  }, [rows]);

  const parsed = useMemo(
    () => mergeIntervals(
      rows
        .map(r => ({ start: Number(r.start), end: Number(r.end) }))
        .filter(x => Number.isInteger(x.start) && Number.isInteger(x.end) && x.start >= 0 && x.end > x.start)
    ),
    [rows]
  );

  const submit = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (errors.length) return onError(new Error(`${errors[0]}，整次拒绝`));
    setSaved(false);
    try {
      const r = await api.saveStoppages({
        expectedRevision: event.revision,
        stoppages: parsed.map(x => ({ startSecs: x.start, endSecs: x.end })),
      });
      setSaved(true);
      await onChanged();
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      onError(err);
    }
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  return (
    <div className="panel">
      <h2>统一停表区间（天气等）</h2>
      <p className="muted small">
        赛事因天气等原因统一停表时，按<b>距发枪秒数</b>登记停表区间；起止均为<b>非负整数</b>且起点小于终点。
        区间可重叠，核算时按<b>并集只计一次</b>（保存后自动合并）。完成者的<b>净耗时 = 原始耗时 −
        停表区间并集与其「出发→终点」区间的交长</b>，排名与并列按净耗时；
        <b>关卡与终点截止、有效链仍按原始秒数判定</b>，未完赛者无净耗时。保存须携带当前修订号，
        无效区间会被整次拒绝；已发布版本冻结当时区间，后续调整不改历史版。
      </p>

      <table className="grid compact">
        <thead><tr><th style={{ width: 60 }}>#</th><th>起点（距发枪秒）</th><th>终点（距发枪秒）</th><th>时长</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td><input type="number" min="0" value={r.start} onChange={e => setRow(i, { start: e.target.value })} style={{ width: 140 }} /></td>
              <td><input type="number" min="0" value={r.end} onChange={e => setRow(i, { end: e.target.value })} style={{ width: 140 }} /></td>
              <td className="small muted">
                {Number.isInteger(Number(r.start)) && Number.isInteger(Number(r.end)) && Number(r.end) > Number(r.start)
                  ? `${Number(r.end) - Number(r.start)}s`
                  : '—'}
              </td>
              <td><button className="btn small danger" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>删除</button></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan="5" className="muted">暂无停表区间（空集合表示赛事全程未停表）。</td></tr>
          )}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn" onClick={() => setRows(rs => [...rs, { start: '', end: '' }])}>+ 添加区间</button>
        <button className="btn primary" onClick={submit}>保存区间（基于修订 #{event?.revision ?? '—'}）</button>
        {saved && <span className="ok-text">已保存</span>}
      </div>

      {errors.length > 0 && (
        <ul className="rules" style={{ color: '#c62828' }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      <h3>保存后生效的并集（重叠只计一次）</h3>
      {parsed.length === 0 ? (
        <p className="muted small">空并集：净耗时等于原始耗时。</p>
      ) : (
        <div className="chain">
          {parsed.map((x, i) => (
            <span className="chip" key={i} title={`${fmtTime(x.start)} → ${fmtTime(x.end)}`}>
              {x.start}s–{x.end}s<small>{x.end - x.start}s</small>
            </span>
          ))}
          <span className="muted small">合计停表 {parsed.reduce((n, x) => n + x.end - x.start, 0)}s（仅按并集计）</span>
        </div>
      )}
    </div>
  );
}

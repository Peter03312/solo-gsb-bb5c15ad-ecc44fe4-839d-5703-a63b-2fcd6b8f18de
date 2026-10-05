import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const EMPTY_GROUP = () => ({ name: '', cutoffSecs: '', points: '' });
const EMPTY_DIV = () => ({ code: '', name: '', finishCutoff: '', groups: [EMPTY_GROUP()] });

/** 组别赛道 + 选手归属维护：与后端同一套整次校验规则，保存携带修订号原子生效 */
export default function Divisions({ event, onChanged, onError }) {
  // 草稿：divs = [{ code, name, finishCutoff, groups: [{ name, cutoffSecs, points(逗号分隔字符串) }] }]
  const [divs, setDivs] = useState([]);
  // 归属草稿：bib -> divisionCode（'' 表示未分组，走默认赛道）
  const [asg, setAsg] = useState({});
  const [runners, setRunners] = useState([]); // [{ bib, name }]
  const [extraBib, setExtraBib] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dv, rs] = await Promise.all([api.divisions(), api.results()]);
      setDivs((dv.divisions || []).map(d => ({
        code: d.code,
        name: d.name,
        finishCutoff: String(d.finishCutoff),
        groups: d.groups.map(g => ({
          name: g.name,
          cutoffSecs: g.cutoffSecs == null ? '' : String(g.cutoffSecs),
          points: g.points.join(', '),
        })),
      })));
      const map = {};
      for (const a of dv.assignments || []) map[a.bib] = a.divisionCode;
      setAsg(map);
      setRunners((rs.results || []).map(r => ({ bib: r.bib, name: r.name })));
    } catch {
      /* 未配置赛事时保持空草稿 */
    }
  }, []);

  useEffect(() => { if (event?.configured) load(); }, [event, load]);

  const setDiv = (i, patch) => setDivs(ds => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const setGroup = (i, gi, patch) =>
    setDivs(ds => ds.map((d, j) => (j === i
      ? { ...d, groups: d.groups.map((g, k) => (k === gi ? { ...g, ...patch } : g)) }
      : d)));

  // 归属表中的号码布 = 已有选手 ∪ 草稿归属中的号码布
  const bibRows = useMemo(() => {
    const m = new Map(runners.map(r => [r.bib, r.name]));
    for (const bib of Object.keys(asg)) if (!m.has(bib)) m.set(bib, null);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [runners, asg]);

  const divCodes = useMemo(() => divs.map(d => d.code.trim()).filter(Boolean), [divs]);

  /** 客户端即时校验，错误文案与后端 400 保持一致（后端仍会整次校验兜底） */
  const errors = useMemo(() => {
    const errs = [];
    const codes = new Set();
    divs.forEach((d, i) => {
      const where = `第 ${i + 1} 个组别`;
      const code = d.code.trim();
      if (!code) return errs.push(`${where}：组别代码必填`);
      if (codes.has(code)) return errs.push(`组别代码「${code}」重复`);
      codes.add(code);
      if (!d.name.trim()) errs.push(`组别「${code}」名称必填`);
      const fc = Number(d.finishCutoff);
      if (d.finishCutoff.trim() === '' || !Number.isInteger(fc) || fc < 0)
        errs.push(`组别「${code}」终点截止秒数须为非负整数`);
      if (d.groups.length === 0) errs.push(`组别「${code}」至少设置一个有序关卡组`);
      const used = new Set();
      d.groups.forEach((g, gi) => {
        if (!g.name.trim()) errs.push(`组别「${code}」第 ${gi + 1} 组名称非法`);
        if (g.cutoffSecs !== '') {
          const c = Number(g.cutoffSecs);
          if (!Number.isInteger(c) || c < 0) errs.push(`组别「${code}」组「${g.name}」截止秒数须为非负整数或留空`);
        }
        const pts = g.points.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
        if (pts.length === 0) errs.push(`组别「${code}」组「${g.name}」替代点位为空`);
        for (const p of pts) {
          if (event && (p === event.startPoint || p === event.finishPoint))
            errs.push(`点位 ${p} 不能与起点/终点相同`);
          if (used.has(p)) errs.push(`点位 ${p} 在组别「${code}」的多个组中出现`);
          used.add(p);
        }
      });
    });
    for (const [bib, code] of Object.entries(asg)) {
      if (code && !codes.has(code)) errs.push(`号码布 ${bib} 归属未知组别「${code}」`);
    }
    return errs;
  }, [divs, asg, event]);

  const addExtraBib = () => {
    const bib = extraBib.trim();
    if (!bib) return;
    if (!(bib in asg)) setAsg(a => ({ ...a, [bib]: '' }));
    setExtraBib('');
  };

  const submit = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (errors.length) return onError(new Error(`${errors[0]}，整次拒绝`));
    setSaved(false);
    const payload = {
      expectedRevision: event.revision,
      divisions: divs.map(d => ({
        code: d.code.trim(),
        name: d.name.trim(),
        finishCutoff: Number(d.finishCutoff),
        groups: d.groups.map(g => ({
          name: g.name.trim(),
          cutoffSecs: g.cutoffSecs === '' ? null : Number(g.cutoffSecs),
          points: g.points.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
        })),
      })),
      assignments: Object.entries(asg)
        .filter(([, code]) => code)
        .map(([bib, divisionCode]) => ({ bib, divisionCode })),
    };
    try {
      await api.saveDivisions(payload);
      setSaved(true);
      await onChanged();
      await load();
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      onError(err);
    }
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  return (
    <div className="panel">
      <h2>组别赛道与选手归属</h2>
      <p className="muted small">
        同场赛事可为不同<b>组别</b>设置各自赛道：有序关卡组（含<b>可替代点位</b>与组截止）与<b>终点截止</b>；
        起点/终点点位与停表区间仍全赛事统一。按<b>号码布</b>指定选手组别，<b>未分组者沿用「关卡设置」中的默认赛道</b>。
        选手按所属赛道构造有效链，停表与净耗时规则不变；<b>rank 仍为全场净耗时名次</b>，另在每个赛道
        （组别/默认）的完赛者中计算允许并列的 <b>groupRank 组内名次</b>，未完赛者两种名次均为空。
        保存整体替换、原子生效并携带修订号；<b>未知组别、重复归属、空替代点位</b>都会被整次拒绝；
        已发布版本冻结当时的组别赛道、归属与两种名次，后续变更不改历史。
      </p>

      <h3>组别赛道（{divs.length} 个组别）</h3>
      {divs.map((d, i) => (
        <fieldset key={i} className="group-box">
          <legend>组别 {i + 1}</legend>
          <div className="form-row three">
            <label>组别代码<input value={d.code} onChange={e => setDiv(i, { code: e.target.value })} placeholder="如：ME" /></label>
            <label>组别名称<input value={d.name} onChange={e => setDiv(i, { name: e.target.value })} placeholder="如：男子精英组" /></label>
            <label>终点截止（秒）<input type="number" min="0" value={d.finishCutoff} onChange={e => setDiv(i, { finishCutoff: e.target.value })} /></label>
          </div>
          {d.groups.map((g, gi) => (
            <div className="form-row three" key={gi}>
              <label>第 {gi + 1} 组组名<input value={g.name} onChange={e => setGroup(i, gi, { name: e.target.value })} placeholder="如：山脊组" /></label>
              <label>组截止秒数（可空）<input type="number" min="0" value={g.cutoffSecs} onChange={e => setGroup(i, gi, { cutoffSecs: e.target.value })} /></label>
              <label>可替代点位（逗号分隔）<input value={g.points} onChange={e => setGroup(i, gi, { points: e.target.value })} placeholder="A1, A2" /></label>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => setDiv(i, { groups: [...d.groups, EMPTY_GROUP()] })}>+ 添加关卡组</button>
          {d.groups.length > 1 && (
            <button type="button" className="btn small" onClick={() => setDiv(i, { groups: d.groups.slice(0, -1) })}>删除末组</button>
          )}
          <button type="button" className="btn small danger" onClick={() => setDivs(ds => ds.filter((_, j) => j !== i))}>删除该组别</button>
        </fieldset>
      ))}
      {divs.length === 0 && <p className="muted small">暂无组别：全部选手沿用默认赛道。保存空组别列表可清除全部组别与归属。</p>}
      <button type="button" className="btn" onClick={() => setDivs(ds => [...ds, EMPTY_DIV()])}>+ 添加组别</button>

      <h3>选手归属（按号码布）</h3>
      <table className="grid compact">
        <thead><tr><th>号码布</th><th>姓名</th><th>归属组别</th></tr></thead>
        <tbody>
          {bibRows.map(([bib, name]) => (
            <tr key={bib}>
              <td>{bib}</td>
              <td>{name || <span className="muted">（待导入打卡）</span>}</td>
              <td>
                <select value={asg[bib] || ''} onChange={e => setAsg(a => ({ ...a, [bib]: e.target.value }))}>
                  <option value="">未分组（默认赛道）</option>
                  {divCodes.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </td>
            </tr>
          ))}
          {bibRows.length === 0 && <tr><td colSpan="3" className="muted">暂无选手。</td></tr>}
        </tbody>
      </table>
      <div className="inline-fields">
        <label>为尚未导入的号码布预先归属
          <input value={extraBib} onChange={e => setExtraBib(e.target.value)} placeholder="号码布" style={{ width: 120 }} />
        </label>
        <button type="button" className="btn small" onClick={addExtraBib}>加入归属表</button>
      </div>

      {errors.length > 0 && (
        <ul className="rules" style={{ color: '#c62828' }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      <div className="actions">
        <button className="btn primary" onClick={submit}>保存组别与归属（基于修订 #{event?.revision ?? '—'}）</button>
        {saved && <span className="ok-text">已保存</span>}
      </div>
    </div>
  );
}

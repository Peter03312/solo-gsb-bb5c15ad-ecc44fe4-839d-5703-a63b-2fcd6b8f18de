import React, { useState } from 'react';
import { api } from '../api.js';

const EMPTY = {
  name: '',
  startPoint: 'S',
  finishPoint: 'F',
  finishCutoff: 1800,
  groups: [{ name: '', cutoffSecs: '', points: '' }],
};

export default function Setup({ event, onChanged, onError }) {
  const [form, setForm] = useState(() => prefill(event) ?? EMPTY);
  const [saved, setSaved] = useState(false);

  function prefill(ev) {
    if (!ev?.configured) return null;
    return {
      name: ev.name,
      startPoint: ev.startPoint,
      finishPoint: ev.finishPoint,
      finishCutoff: ev.finishCutoff,
      groups: ev.groups.map(g => ({
        name: g.name,
        cutoffSecs: g.cutoffSecs ?? '',
        points: g.points.join(', '),
      })),
    };
  }

  // 赛事数据加载后再同步一次表单
  React.useEffect(() => {
    if (event?.configured) setForm(prefill(event));
  }, [event]);

  const setGroup = (i, patch) =>
    setForm(f => ({ ...f, groups: f.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) }));

  const submit = async e => {
    e.preventDefault();
    setSaved(false);
    const payload = {
      name: form.name,
      startPoint: form.startPoint.trim(),
      finishPoint: form.finishPoint.trim(),
      finishCutoff: Number(form.finishCutoff),
      expectedRevision: event?.revision ?? 0,
      groups: form.groups.map(g => ({
        name: g.name,
        cutoffSecs: g.cutoffSecs === '' ? null : Number(g.cutoffSecs),
        points: g.points.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
      })),
    };
    try {
      const r = await api.setup(payload);
      setSaved(true);
      await onChanged();
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      onError(err);
    }
  };

  return (
    <form onSubmit={submit} className="panel">
      <h2>关卡组与截止秒数</h2>
      <p className="muted small">
        关卡组按顺序通过；每组填写可替代点位（逗号分隔，任选其一即可）。组截止秒数可留空，终点截止必填。
      </p>
      <div className="form-row">
        <label>赛事名称<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label>
      </div>
      <div className="form-row three">
        <label>起点<input value={form.startPoint} onChange={e => setForm({ ...form, startPoint: e.target.value })} required /></label>
        <label>终点<input value={form.finishPoint} onChange={e => setForm({ ...form, finishPoint: e.target.value })} required /></label>
        <label>终点截止（秒）<input type="number" min="0" value={form.finishCutoff} onChange={e => setForm({ ...form, finishCutoff: e.target.value })} required /></label>
      </div>

      {form.groups.map((g, i) => (
        <fieldset key={i} className="group-box">
          <legend>第 {i + 1} 组</legend>
          <div className="form-row three">
            <label>组名<input value={g.name} onChange={e => setGroup(i, { name: e.target.value })} placeholder="如：北山组" required /></label>
            <label>组截止秒数（可空）<input type="number" min="0" value={g.cutoffSecs} onChange={e => setGroup(i, { cutoffSecs: e.target.value })} /></label>
            <label>可替代点位（逗号分隔）<input value={g.points} onChange={e => setGroup(i, { points: e.target.value })} placeholder="A1, A2" required /></label>
          </div>
          {form.groups.length > 1 && (
            <button type="button" className="btn danger small" onClick={() => setForm(f => ({ ...f, groups: f.groups.filter((_, j) => j !== i) }))}>
              删除该组
            </button>
          )}
        </fieldset>
      ))}
      <button type="button" className="btn" onClick={() => setForm(f => ({ ...f, groups: [...f.groups, { name: '', cutoffSecs: '', points: '' }] }))}>
        + 添加关卡组
      </button>
      <div className="actions">
        <button className="btn primary" type="submit">保存设置（基于修订 #{event?.revision ?? 0}）</button>
        {saved && <span className="ok-text">已保存</span>}
      </div>
    </form>
  );
}

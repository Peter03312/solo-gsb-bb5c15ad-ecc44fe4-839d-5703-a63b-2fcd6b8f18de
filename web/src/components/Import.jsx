import React, { useState } from 'react';
import { api } from '../api.js';

const SAMPLE = `[
  { "recordNo": "R1001", "bib": "007", "name": "周杰", "point": "S",  "seconds": 0,    "kind": "start" },
  { "recordNo": "R1002", "bib": "007", "name": "周杰", "point": "A1", "seconds": 320,  "kind": "enroute" },
  { "recordNo": "R1003", "bib": "007", "name": "周杰", "point": "B2", "seconds": 780,  "kind": "enroute" },
  { "recordNo": "R1004", "bib": "007", "name": "周杰", "point": "F",  "seconds": 1100, "kind": "finish" }
]`;

/** 支持 JSON 数组，或 CSV/TSV：recordNo,bib,point,seconds,kind[,name]（首行可为表头） */
function parseInput(text) {
  const t = text.trim();
  if (!t) throw new Error('内容为空');
  if (t[0] === '[' || t[0] === '{') {
    const data = JSON.parse(t);
    const arr = Array.isArray(data) ? data : [data];
    return arr;
  }
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const split = l => l.split(/[,\t;，；]/).map(s => s.trim());
  // 表头判定：含已知列名，或第 4 列（seconds）不是数字
  const isHeader = cells =>
    cells.some(c => /^(recordno|bib|point|seconds|kind|name)$/i.test(c)) ||
    !Number.isFinite(Number(cells[3]));
  let headers = null;
  const rows = [];
  for (const line of lines) {
    const cells = split(line);
    if (!headers && isHeader(cells)) {
      headers = cells.map(s => s.toLowerCase());
      continue;
    }
    if (headers) {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i]; });
      rows.push(obj);
    } else {
      const [recordNo, bib, point, seconds, kind, name] = cells;
      rows.push({ recordNo, bib, point, seconds, kind, name });
    }
  }
  return rows.map(r => ({ ...r, seconds: Number(r.seconds) }));
}

export default function Import({ event, onChanged, onError }) {
  const [text, setText] = useState(SAMPLE);
  const [result, setResult] = useState(null);

  const doImport = async () => {
    setResult(null);
    if (!event?.configured) return onError(new Error('请先配置赛事关卡'));
    let punches;
    try {
      punches = parseInput(text);
    } catch (err) {
      return onError(new Error(`解析失败：${err.message}`));
    }
    try {
      const r = await api.importPunches({ expectedRevision: event.revision, punches });
      setResult({ ok: true, text: `导入完成：新增 ${r.inserted} 条，幂等跳过 ${r.skipped} 条，新修订 #${r.revision}` });
      await onChanged();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="panel">
      <h2>打卡批量导入</h2>
      <ul className="muted small rules">
        <li>每条含 <b>记录号 recordNo</b>、号码布 bib、点位 point、<b>距发枪秒数 seconds</b>、类型 kind(start/enroute/finish)。</li>
        <li>同号判定以该记录<b>首次入库的原始读数</b>为准：原始内容完全一致 → 幂等跳过（即使已被裁判更正或作废，也不覆盖现值、状态与审计）。</li>
        <li><b>同记录号原始内容不同（批内或与库中），或出现负秒数，整批拒绝、全部不入库</b>；批次混有新记录时也不会部分入库。</li>
        <li>全部为幂等跳过时不推进修订号；只要有新增即修订号 +1。提交须携带当前修订号，赛事已被他人修订时返回 409 与当前修订号，需刷新后重试。</li>
        <li>支持 JSON 数组，或 CSV/TSV（表头：recordNo,bib,point,seconds,kind,name）。</li>
      </ul>
      <textarea className="code-input" rows={14} value={text} onChange={e => setText(e.target.value)} spellCheck="false" />
      <div className="actions">
        <button className="btn primary" onClick={doImport}>校验并导入（修订 #{event?.revision ?? '—'}）</button>
        {result?.ok && <span className="ok-text">{result.text}</span>}
      </div>
    </div>
  );
}

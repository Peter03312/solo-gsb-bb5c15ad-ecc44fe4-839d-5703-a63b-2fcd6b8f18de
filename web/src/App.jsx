import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Setup from './components/Setup.jsx';
import Import from './components/Import.jsx';
import Results from './components/Results.jsx';
import Review from './components/Review.jsx';
import Appeal from './components/Appeal.jsx';
import Publish from './components/Publish.jsx';
import Stoppages from './components/Stoppages.jsx';
import Divisions from './components/Divisions.jsx';

const TABS = [
  { key: 'results', label: '成绩排名' },
  { key: 'divisions', label: '组别赛道' },
  { key: 'stoppages', label: '停表区间' },
  { key: 'appeal', label: '整案申诉' },
  { key: 'review', label: '争议复核' },
  { key: 'import', label: '打卡导入' },
  { key: 'setup', label: '关卡设置' },
  { key: 'publish', label: '发布冻结' },
];

export default function App() {
  const [tab, setTab] = useState('results');
  const [event, setEvent] = useState(null);
  const [notice, setNotice] = useState(null);

  const refreshEvent = useCallback(async () => {
    const ev = await apiSafe(api.event());
    setEvent(ev);
    return ev;
  }, []);

  useEffect(() => {
    refreshEvent();
  }, [refreshEvent]);

  // 数据被其他裁判/页面更改（修订号过期）时统一提示并刷新
  const showStale = useCallback(
    err => {
      if (err?.status === 409) {
        setNotice({ type: 'warn', text: `${err.message}${err.currentRevision ? `，当前修订号：${err.currentRevision}` : ''}` });
        refreshEvent();
      } else {
        setNotice({ type: 'error', text: err?.message || '操作失败' });
      }
    },
    [refreshEvent]
  );

  const clearNotice = () => setNotice(null);

  return (
    <div className="app">
      <header className="topbar">
        <h1>定向越野打卡争议复核</h1>
        <div className="rev-badge" title="赛事修订号：任何关卡/读数/更正变化都会推进">
          {event?.configured ? (
            <>
              {event.name}
              <span className="rev">修订 #{event.revision}</span>
            </>
          ) : (
            <span>赛事未配置</span>
          )}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map(t => (
          <button key={t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => { setTab(t.key); clearNotice(); }}>
            {t.label}
          </button>
        ))}
      </nav>

      {notice && (
        <div className={`notice ${notice.type}`}>
          <span>{notice.text}</span>
          <button onClick={clearNotice}>×</button>
        </div>
      )}

      <main className="content">
        {tab === 'setup' && <Setup event={event} onChanged={refreshEvent} onError={showStale} />}
        {tab === 'import' && <Import event={event} onChanged={refreshEvent} onError={showStale} />}
        {tab === 'results' && <Results />}
        {tab === 'divisions' && <Divisions event={event} onChanged={refreshEvent} onError={showStale} />}
        {tab === 'stoppages' && <Stoppages event={event} onChanged={refreshEvent} onError={showStale} />}
        {tab === 'appeal' && <Appeal event={event} onChanged={refreshEvent} onError={showStale} />}
        {tab === 'review' && <Review event={event} onChanged={refreshEvent} onError={showStale} />}
        {tab === 'publish' && <Publish event={event} onChanged={refreshEvent} onError={showStale} />}
      </main>
    </div>
  );
}

async function apiSafe(p) {
  try {
    return await p;
  } catch {
    return null;
  }
}

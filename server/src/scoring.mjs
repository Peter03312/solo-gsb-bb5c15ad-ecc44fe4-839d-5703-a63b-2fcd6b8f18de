// 成绩核算核心：从出发后读数中选出「时间严格递增、依序通过各组、截止前到终点」
// 的最早有效链（贪心：每组取时间允许范围内最早的一条有效打卡）。
// 逆序打卡、多余打卡不作完成依据。

/** 读取当前赛事配置（含默认赛道关卡、停表区间并集、组别赛道与选手归属） */
export function loadConfig(db) {
  const ev = db.prepare('SELECT * FROM event WHERE id = 1').get();
  if (!ev) return null;
  const groups = db
    .prepare('SELECT id, seq, name, cutoff_secs FROM checkpoint_group ORDER BY seq')
    .all();
  for (const g of groups) {
    g.points = db
      .prepare('SELECT point FROM group_point WHERE group_id = ? ORDER BY seq')
      .all(g.id)
      .map((r) => r.point);
  }
  const stoppages = mergeIntervals(
    db.prepare('SELECT start_secs AS start, end_secs AS end FROM stoppage_interval').all()
  );
  // 组别赛道：每组别有自己有序关卡组（含替代点位与组截止）与终点截止
  const divisions = db
    .prepare('SELECT id, code, name, finish_cutoff, seq FROM division ORDER BY seq')
    .all();
  for (const d of divisions) {
    d.groups = db
      .prepare('SELECT id, seq, name, cutoff_secs FROM division_group WHERE division_id = ? ORDER BY seq')
      .all(d.id);
    for (const g of d.groups) {
      g.points = db
        .prepare('SELECT point FROM division_group_point WHERE group_id = ? ORDER BY seq')
        .all(g.id)
        .map((r) => r.point);
    }
  }
  // 选手归属：bib -> division_id（未归属者沿用默认赛道）
  const assignments = {};
  for (const r of db.prepare('SELECT bib, division_id FROM runner_division').all())
    assignments[r.bib] = r.division_id;
  return { ...ev, groups, stoppages, divisions, assignments };
}

/**
 * 解析某号码布实际使用的赛道：归属组别 -> 该组别赛道；未分组 -> 赛事默认赛道。
 * 起点/终点点位与停表区间为全赛事统一，只有关卡组序列与终点截止按赛道不同。
 */
export function resolveCourse(config, bib) {
  const divId = config.assignments ? config.assignments[bib] : null;
  const div = divId != null ? (config.divisions || []).find((d) => d.id === divId) : null;
  if (div) return { groups: div.groups, finishCutoff: div.finish_cutoff, division: div };
  return { groups: config.groups, finishCutoff: config.finish_cutoff, division: null };
}

/**
 * 区间并集：把 [start,end)（半开，秒为整数所以与闭区间等长）合并为不交且按起点升序的数组。
 * 相邻（a.end === b.start）也合并；输入须先通过 start>=0、start<end 的校验。
 */
export function mergeIntervals(raw) {
  const ivs = (raw || [])
    .map((x) => ({ start: Number(x.start), end: Number(x.end) }))
    .sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const out = [];
  for (const iv of ivs) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/** 并集区间与 [lo,hi) 的交长（整数秒数；lo>=hi 时为 0）。 */
export function overlapLength(intervals, lo, hi) {
  if (hi <= lo) return 0;
  let len = 0;
  for (const iv of intervals) {
    const s = Math.max(iv.start, lo);
    const e = Math.min(iv.end, hi);
    if (e > s) len += e - s;
  }
  return len;
}

/**
 * 计算所有选手成绩。
 * 返回按净耗时排序的结果数组（无有效链排后），同净耗时并列。
 */
export function computeResults(db, config = loadConfig(db)) {
  if (!config) return [];
  const runners = db.prepare('SELECT bib, name FROM runner ORDER BY bib').all();
  const results = runners.map((r) => {
    const readings = db
      .prepare(
        `SELECT id, record_no, point, seconds, kind FROM punch
         WHERE bib = ? AND status = 'active' ORDER BY seconds, id`
      )
      .all(r.bib);
    return computeRunnerFromReadings(readings, config, r.bib, r.name);
  });
  return rankResults(results);
}

/**
 * 全场名次 + 组内名次。
 * - rank：全部完赛者按净耗时升序（含并列），无有效链不排名；
 * - groupRank：只在「同组完赛者」中按净耗时排名（允许并列），
 *   同组 = 归属同一组别；未分组者彼此构成默认赛道组。未完赛者两种名次均为空。
 * 可用于内存中的预演结果。
 */
export function rankResults(results) {
  const netOf = (r) => (r.netElapsed != null ? r.netElapsed : r.elapsed);
  results.sort((a, b) => {
    if (a.elapsed == null && b.elapsed == null) return a.bib.localeCompare(b.bib);
    if (a.elapsed == null) return 1;
    if (b.elapsed == null) return -1;
    const na = netOf(a);
    const nb = netOf(b);
    if (na !== nb) return na - nb;
    return a.bib.localeCompare(b.bib);
  });
  // 并列名次（按净耗时）
  let rank = 0;
  let prevNet = null;
  results.forEach((r, i) => {
    if (r.elapsed != null) {
      const n = netOf(r);
      if (n !== prevNet) rank = i + 1;
      r.rank = rank;
      prevNet = n;
    }
  });
  // 组内名次：同赛道（同组别；未分组者同属默认赛道）完赛者之间按净耗时并列排名
  const cohorts = new Map();
  for (const r of results) {
    if (r.elapsed == null) continue; // 未完赛者两种名次均为空
    const key = r.divisionCode || '';
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(r);
  }
  for (const list of cohorts.values()) {
    list.sort((a, b) => {
      const na = netOf(a);
      const nb = netOf(b);
      if (na !== nb) return na - nb;
      return a.bib.localeCompare(b.bib);
    });
    let gRank = 0;
    let gPrev = null;
    list.forEach((r, i) => {
      const n = netOf(r);
      if (n !== gPrev) gRank = i + 1;
      r.groupRank = gRank;
      gPrev = n;
    });
  }
  return results;
}

/**
 * 单个选手的有效链。
 * 有效读数 = status='active'（作废/已被更正的旧读数不参与）。
 */
export function computeRunner(db, config, bib, name = null) {
  const punches = db
    .prepare(
      `SELECT id, record_no, point, seconds, kind FROM punch
       WHERE bib = ? AND status = 'active' ORDER BY seconds, id`
    )
    .all(bib);
  return computeRunnerFromReadings(punches, config, bib, name);
}

/**
 * 纯函数版核算：给定某选手的有效读数数组（内存预演可用虚拟读数），
 * 计算最早有效链、失败原因与耗时。readings 形如 { record_no, point, seconds, kind }。
 * 赛道按号码布解析：归属组别用该组别赛道，未分组沿用赛事默认赛道。
 */
export function computeRunnerFromReadings(readings, config, bib, name = null) {
  const course = resolveCourse(config, bib);
  const base = {
    bib, name, status: 'ok',
    elapsed: null, // 原始耗时（终点 − 出发秒数），语义不变
    netElapsed: null, // 净耗时 = 原始耗时 − 停表区间并集与[出发,终点]的交长；未完赛者无
    stoppedSecs: null, // 该选手中被扣减的停表秒数
    rank: null, // 全场净耗时名次（rankResults 统一填写）
    groupRank: null, // 同组完赛者中的组内名次（rankResults 统一填写）
    divisionCode: course.division ? course.division.code : null, // 归属组别；null = 未分组（默认赛道）
    divisionName: course.division ? course.division.name : null,
    failAt: null, detail: '', chain: [],
  };
  // 保证按 seconds、记录次序严格递增处理（调用方通常已排序，这里再排一次以免预演漏排）
  const punches = [...readings].sort((a, b) =>
    a.seconds !== b.seconds ? a.seconds - b.seconds : String(a.record_no).localeCompare(String(b.record_no))
  );

  // 唯一出发打卡（kind=start）。途中再次经过起点的打卡属于多余打卡，不作出发依据。
  const starts = punches.filter((p) => p.kind === 'start');
  if (starts.length === 0)
    return { ...base, status: 'no_start', detail: '缺少出发打卡' };
  if (starts.length > 1)
    return { ...base, status: 'bad_start', detail: '出发打卡不唯一' };
  const start = starts[0];
  if (start.point !== config.start_point)
    return { ...base, status: 'bad_start', detail: `出发打卡点位非起点「${config.start_point}」` };

  const after = punches.filter((p) => p.record_no !== start.record_no && p.seconds >= start.seconds);
  let lastSeconds = start.seconds;
  const chain = [slim(start)];

  // 依序通过所属赛道的各组：每组选时间严格递增的最早一条（可替代点位任一即可）
  for (const g of course.groups) {
    const hit = after.find(
      (p) =>
        p.seconds > lastSeconds &&
        g.points.includes(p.point) &&
        (g.cutoff_secs == null || p.seconds <= g.cutoff_secs)
    );
    if (!hit) {
      // 区分：组截止前未到
      const reason =
        g.cutoff_secs == null
          ? `未按顺序通过「${g.name}」（无严格递增的组内有效打卡）`
          : `未在 ${g.cutoff_secs} 秒截止前通过「${g.name}」`;
      return { ...base, status: 'group_dnf', failAt: g.name, detail: reason, chain };
    }
    chain.push(slim(hit));
    lastSeconds = hit.seconds;
  }

  // 终点：严格递增且在所属赛道终点截止前（含等于）
  const finish = after.find(
    (p) =>
      p.point === config.finish_point &&
      p.seconds > lastSeconds &&
      p.seconds <= course.finishCutoff
  );
  if (!finish) {
    const late = after
      .filter((p) => p.point === config.finish_point && p.seconds > lastSeconds)
      .sort((a, b) => a.seconds - b.seconds)[0];
    const detail = late
      ? `终点超时：${late.seconds}s 超过截止 ${course.finishCutoff}s`
      : `未在 ${course.finishCutoff} 秒截止前到达终点`;
    return { ...base, status: 'finish_dnf', failAt: '终点', detail, chain };
  }
  chain.push(slim(finish));
  // 原始耗时语义不变；关卡/终点截止与有效链均按原始秒数判定（见上方循环）。
  // 净耗时：仅扣减停表区间并集与「出发→终点」区间的交长；重叠区间只计一次。
  const elapsed = finish.seconds - start.seconds;
  const stoppedSecs = overlapLength(config.stoppages || [], start.seconds, finish.seconds);
  return { ...base, elapsed, stoppedSecs, netElapsed: elapsed - stoppedSecs, chain };
}

function slim(p) {
  return { record_no: p.record_no, point: p.point, seconds: p.seconds, kind: p.kind };
}

// 首次启动时可选地写入演示赛事（SEED=1 时生效）。
import { bumpRevision } from './db.mjs';

export function seedDemo(db) {
  if (db.prepare('SELECT v FROM meta WHERE k = ?').get('seeded')) return false;
  if (!db.prepare('SELECT 1 FROM event WHERE id = 1').get()) {
    // 赛事：起点 S，终点 F，终点截止 1800s；两组顺序关卡，各含可替代点位
    db.prepare(
      `INSERT INTO event (id, name, start_point, finish_point, finish_cutoff, revision)
       VALUES (1, ?, 'S', 'F', 1800, 0)`
    ).run('2026 秋季定向越野挑战赛');

    const g1 = db
      .prepare('INSERT INTO checkpoint_group (seq, name, cutoff_secs) VALUES (1, ?, 600)')
      .run('北山组').lastInsertRowid;
    const g2 = db
      .prepare('INSERT INTO checkpoint_group (seq, name, cutoff_secs) VALUES (2, ?, 1200)')
      .run('湖畔组').lastInsertRowid;
    const insPt = db.prepare('INSERT INTO group_point (group_id, point, seq) VALUES (?, ?, ?)');
    insPt.run(g1, 'A1', 1); insPt.run(g1, 'A2', 2);
    insPt.run(g2, 'B1', 1); insPt.run(g2, 'B2', 2);

    // 天气原因统一停表：距发枪 500s–600s（重叠区间只计一次；净耗时排名时扣减）
    const insStop = db.prepare('INSERT INTO stoppage_interval (start_secs, end_secs) VALUES (?, ?)');
    insStop.run(500, 600);

    // 示范组别赛道：同场赛事不同组别走不同关卡序列与终点截止；未分组选手沿用上方默认赛道
    const insDiv = db.prepare('INSERT INTO division (code, name, finish_cutoff, seq) VALUES (?, ?, ?, ?)');
    const insDG = db.prepare('INSERT INTO division_group (division_id, seq, name, cutoff_secs) VALUES (?, ?, ?, ?)');
    const insDGP = db.prepare('INSERT INTO division_group_point (group_id, point, seq) VALUES (?, ?, ?)');
    const meId = insDiv.run('ME', '男子精英组', 1800, 1).lastInsertRowid;
    const meG1 = insDG.run(meId, 1, '山脊组', 600).lastInsertRowid;
    const meG2 = insDG.run(meId, 2, '湖畔组', 1200).lastInsertRowid;
    insDGP.run(meG1, 'A1', 1); insDGP.run(meG1, 'A2', 2);
    insDGP.run(meG2, 'B1', 1); insDGP.run(meG2, 'B2', 2);
    const weId = insDiv.run('WE', '女子精英组', 1200, 2).lastInsertRowid;
    const weG1 = insDG.run(weId, 1, '近郊组', 500).lastInsertRowid;
    insDGP.run(weG1, 'C1', 1); insDGP.run(weG1, 'C2', 2);

    const insRunner = db.prepare('INSERT INTO runner (bib, name) VALUES (?, ?)');
    insRunner.run('001', '张明'); insRunner.run('002', '李华');
    insRunner.run('003', '王芳'); insRunner.run('004', '赵强');
    insRunner.run('005', '陈晨'); insRunner.run('006', '孙磊');
    insRunner.run('201', '林峰'); insRunner.run('202', '许晴');
    insRunner.run('203', '郑凯');

    // 选手归属：按号码布指定组别（001–006 未分组，沿用默认赛道）
    const insAsg = db.prepare('INSERT INTO runner_division (bib, division_id) VALUES (?, ?)');
    insAsg.run('201', meId); insAsg.run('202', weId); insAsg.run('203', meId);

    // record_no 全局唯一；kind: start | enroute | finish
    // 首次入库时现值即原始读数，orig_* 同步落库
    const insP = db.prepare(
      `INSERT INTO punch (record_no, bib, point, seconds, kind, orig_bib, orig_point, orig_seconds, orig_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const rows = [
      // 001 张明：正常完成 910s（多余的逆序打卡 A2 不作依据）
      ['R0001','001','S',0,'start'], ['R0002','001','X',120,'enroute'],
      ['R0003','001','A2',300,'enroute'], ['R0004','001','B1',700,'enroute'],
      ['R0005','001','A1',820,'enroute'], ['R0006','001','F',910,'finish'],
      // 002 李华：终点超时
      ['R0010','002','S',0,'start'], ['R0011','002','A1',200,'enroute'],
      ['R0012','002','B2',900,'enroute'], ['R0013','002','F',1850,'finish'],
      // 003 王芳：第二组未完成（组截止前未到 B1/B2）
      ['R0020','003','S',0,'start'], ['R0021','003','A1',250,'enroute'],
      ['R0022','003','B1',1250,'enroute'], ['R0023','003','F',1500,'finish'],
      // 004 赵强：与 006 同耗时 1000s 并列；途中含一条明显错误读数待裁判处理
      ['R0030','004','S',0,'start'], ['R0031','004','A1',400,'enroute'],
      ['R0032','004','ZZ',99999,'enroute'], ['R0033','004','B2',720,'enroute'],
      ['R0034','004','F',1000,'finish'],
      // 005 陈晨：出发打卡重复（争议待核）
      ['R0040','005','S',0,'start'], ['R0041','005','S',5,'start'],
      ['R0042','005','A2',350,'enroute'], ['R0043','005','B1',800,'enroute'],
      ['R0044','005','F',980,'finish'],
      // 006 孙磊：与 004 同耗时并列
      ['R0050','006','S',0,'start'], ['R0051','006','A2',400,'enroute'],
      ['R0052','006','B1',700,'enroute'], ['R0053','006','F',1000,'finish'],
      // 201 林峰（ME 男子精英组）：按 ME 赛道完成 1250s
      ['R0201','201','S',0,'start'], ['R0202','201','A1',300,'enroute'],
      ['R0203','201','B2',800,'enroute'], ['R0204','201','F',1250,'finish'],
      // 202 许晴（WE 女子精英组）：按 WE 赛道完成 1100s
      ['R0211','202','S',0,'start'], ['R0212','202','C1',400,'enroute'],
      ['R0213','202','F',1100,'finish'],
      // 203 郑凯（ME 男子精英组）：按 ME 赛道完成 1350s，组内次于 201
      ['R0221','203','S',0,'start'], ['R0222','203','A2',350,'enroute'],
      ['R0223','203','B1',850,'enroute'], ['R0224','203','F',1350,'finish'],
    ];
    const tx = db.transaction(() => {
      for (const r of rows) insP.run(r[0], r[1], r[2], r[3], r[4], r[1], r[2], r[3], r[4]);
      // 关卡初始为修订 #1，演示读数导入后推进
      bumpRevision(db);
      db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('seeded', '1');
    });
    tx();
  }
  return true;
}

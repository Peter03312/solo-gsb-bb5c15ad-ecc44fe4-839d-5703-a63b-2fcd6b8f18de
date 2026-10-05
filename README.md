# 定向越野打卡争议复核系统

主办方设置**按顺序通过的关卡组**（每组含若干**可替代点位**，并可录入**组截止秒数**与统一的**终点截止秒数**）；
系统录入选手的**唯一出发打卡**以及途中、终点打卡（每条含记录号、点位、距发枪秒数），自动核算成绩、
支持裁判作废/更正打卡并**重算**，以及**发布冻结**成绩版本。

**统一停表**：赛事因天气等原因统一停表时，裁判可登记若干**距发枪秒数**表示的停表区间
（起止均为非负整数、起点小于终点，重叠区间只计一次）；完成选手的**净耗时 = 原始耗时 −
停表区间并集与其「出发→终点」区间的交长**，排名与并列按净耗时；`elapsed` 仍为原始耗时，另返回 `netElapsed`，
未完赛者无净耗时。关卡/终点截止与有效链仍按原始秒数判定。停表配置变动须携带 `expectedRevision`，
无效区间整次拒绝；发布版冻结当时的停表区间与净耗时，后续调整不改历史版。

**组别赛道（本轮新增）**：同场赛事可设不同**组别赛道**——裁判为每个参赛组别配置自己的**有序关卡组、
可替代点位及关卡/终点截止**，并按**号码布**指定选手组别；**未分组者沿用默认赛道**。选手按所属赛道构造有效链，
停表与净耗时规则不变；`rank` 保持**全场净耗时名次**，另返回只在**同组完赛者**中计算且**允许并列**的
`groupRank`（未分组者彼此构成默认赛道组），**未完赛者两种名次均为空**。组别赛道或归属变更须携带
`expectedRevision`、原子生效并推动整案预演/确认与实时成绩重算；过期返回当前修订，
**未知组别、重复归属、空替代点位**整次拒绝。发布版冻结组别赛道、归属与两种名次，后续变更不改历史；
旧库与原有未分组调用继续可用。

技术栈：**Node.js + Express + React（Vite）+ SQLite（better-sqlite3）**。

---

## 一键启动（推荐，Docker Compose）

前置要求：安装 Docker 与 Docker Compose。

```bash
docker compose up --build
```

启动后：

- 打开网页：**http://localhost:3000**
- API 根路径：`http://localhost:3000/api/...`
- 容器启动时自动建表（`server/src/schema.sql`）并初始化 SQLite 数据库；
  默认写入一套演示赛事与打卡数据（含逆序多余打卡、终点超时、组未完成、并列、重复出发等待争议样例，
  以及 ME/WE 两个示范组别赛道与 201/202/203 三名已归属选手）。
- 数据库持久化在命名卷 `orienteering-data`（容器内 `/data/orienteering.db`）。

停止：`docker compose down`（数据保留）；连同数据清除：`docker compose down -v`。

仅用 Dockerfile：

```bash
docker build -t orienteering-review .
docker run -p 3000:3000 -v "$PWD/data:/data" -e SEED=1 orienteering-review
```

---

## 本地开发运行

要求 Node.js ≥ 18。

```bash
# 安装依赖
npm run install:all

# 同时启动后端(:3000) 与 Vite 前端(:5173)
npm run dev
```

- 前端开发地址：**http://localhost:5173**（`/api` 自动代理到 3000）
- 后端地址：http://localhost:3000
- 首次运行可用 `SEED=1` 写入演示数据：`SEED=1 npm run dev:server`

生产构建（后端单端口同时提供静态页面与 API）：

```bash
npm run build      # 构建 web/dist
npm start          # http://localhost:3000
```

---

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 后端监听端口 |
| `DB_FILE` | `data/orienteering.db` | SQLite 数据库文件路径，首次启动自动建表 |
| `SEED` | 未设置 | `1` 时在空库中初始化演示赛事（仅生效一次） |
| `WEB_DIST` | `web/dist` | 构建后前端静态目录 |

网页地址与端口：**http://localhost:3000（Docker / 生产）**，开发模式为 **http://localhost:5173**。

---

## 成绩规则

1. 每个选手必须有且仅有一条 `kind=start` 的出发打卡（点位须等于起点）。
2. 从出发后的读数中，按**选手所属赛道**（归属组别 → 该组别赛道；未分组 → 默认赛道）构造**最早有效链**：
   - 关卡组按设置顺序依次通过，每组在其可替代点位中任选其一；
   - 选中打卡的距发枪秒数必须**严格递增**（`>`，相等不算），每组取满足条件的**最早**一条（贪心即最优：
     更早的选择只会给后续更大的时间窗口）；
   - 若该组设置了组截止秒数，还须不晚于该秒数。
3. 终点打卡必须在最后一组之后、且距发枪秒数不超过**所属赛道的终点截止秒数**（`<=`，刚好在截止点有效）。
4. **逆序打卡与多余打卡**（如途中再次经过起点、无关点位、晚于终点的打卡）不作为任何组/终点的完成依据。
5. 完成者按**净耗时**升序排名，**同净耗时并列同名次**；`elapsed`（原始耗时 = 终点秒数 − 出发秒数）语义不变，
   另返回 `netElapsed`（净耗时）与 `stoppedSecs`（被扣减的停表秒数），未完赛者净耗时为 `null`。
6. 名次有两种（均按净耗时、允许并列）：
   - `rank`：**全场**净耗时名次（所有赛道的完赛者一起排）；
   - `groupRank`：只在**同组完赛者**中计算的组内名次——同组 = 归属同一组别，
     **未分组者彼此构成默认赛道组**；**未完赛者两种名次均为空**。
7. 无有效链时指出首个失败位置：
   - 出发缺失/不唯一/点位错误；
   - 第一个未在严格递增且截止前通过的关卡组（含组名与原因）；
   - 终点缺失或**终点超时**（给出实际秒数与所属赛道的截止值）。

## 统一停表与净耗时

赛事因天气等原因**统一停表**时，按「距发枪秒数」登记停表区间，规则如下：

1. 每个区间为 `{ startSecs, endSecs }`，起止均为**非负整数**且 `startSecs < endSecs`（半开 `[start,end)`，
   秒为整数时与闭区间等长）。**任一区间非法 → 整次请求 400 拒绝**（不会部分写入）。
2. 登记区间允许交叠/相邻，存储与核算统一取**并集**（`mergeIntervals`），重叠部分**只计一次**。
3. 完成选手 `netElapsed = elapsed − |停表并集 ∩ [出发秒数, 终点秒数]|`；
   出发前/终点后的停表时间不计；**关卡与终点截止、有效链仍按原始秒数判定**（停表不影响是否完赛）。
4. **未完赛者无净耗时**（`netElapsed`/`stoppedSecs` 均为 `null`），不参与排名。
5. 排名、并列、整案预演/确认前后对比都按净耗时同一规则；`elapsed` 字段含义不变（兼容旧调用方）。
6. 停表配置是赛事单例集合，**整体替换**维护；变动须携带 `expectedRevision`，过期返回 **409 + `currentRevision`**；
   提交内容与现有并集完全相同（含交叠去重后相同）时为只读操作，**不推进修订号**。
7. **发布冻结**当时的停表区间并集与据此算出的净耗时（`stoppages` 进入快照，`published_result.net_elapsed` 落库）；
   之后再调整停表区间，历史版本的区间与净耗时都不变。
8. 旧数据库首次启动自动迁移：新建 `stoppage_interval` 表；为历史 `publication` 回填空区间、
   为历史 `published_result` 回填 `net_elapsed = elapsed`（旧版发布时无停表，净耗时即原始耗时）。

### 停表区间 HTTP 调用示例

```bash
# 1) 查询当前停表区间（已合并的不交并集）与修订号
curl -s http://localhost:3000/api/stoppages
# -> { "configured": true, "revision": 4,
#      "stoppages": [ { "startSecs": 500, "endSecs": 600 } ] }

# 2) 整体替换停表区间（须携带 expectedRevision）
curl -s -X POST http://localhost:3000/api/stoppages \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedRevision": 4,
    "stoppages": [
      { "startSecs": 500, "endSecs": 620 },
      { "startSecs": 600, "endSecs": 700 }
    ]
  }'
# 交叠/相邻区间合并后落库并推进修订：
# -> { "ok": true, "revision": 5, "changed": true,
#      "stoppages": [ { "startSecs": 500, "endSecs": 700 } ] }

# 3) 清空全部停表（空数组合法；有效变更同样推进修订）
curl -s -X POST http://localhost:3000/api/stoppages \
  -H 'Content-Type: application/json' -d '{"expectedRevision":5,"stoppages":[]}'

# 4) 实时成绩同时返回原始耗时与净耗时
curl -s http://localhost:3000/api/results
# -> { "stoppages": [...], "results": [
#      { "bib":"001", "status":"ok", "elapsed":910,
#        "stoppedSecs":100, "netElapsed":810, "rank":1, "chain":[...] },
#      { "bib":"002", "status":"finish_dnf", "elapsed":null,
#        "netElapsed":null, "stoppedSecs":null, ... } ] }

# 5) 无效区间整次拒绝 / 修订过期
# HTTP/1.1 400 -> { "error": "第 2 个区间：起点（700）必须小于终点（600），整次拒绝" }
# HTTP/1.1 409 -> { "error": "赛事已修订，请刷新后重试", "currentRevision": 6 }
```

## 组别赛道与组内名次（本轮新增）

同场赛事可为不同**组别**设置各自赛道，规则如下：

1. 每个组别有自己的**有序关卡组**（每组含**可替代点位**与可选**组截止秒数**）与**终点截止秒数**；
   起点/终点点位、停表区间仍全赛事统一。每个组别至少一个关卡组，每组**替代点位至少一个**
   （空替代点位整次拒绝）；点位不得与起点/终点相同，同一组别赛道内点位不跨组重复（不同组别可共用点位）。
2. **按号码布指定选手组别**（一个号码布最多一个组别）；**未分组者沿用「关卡设置」中的默认赛道**。
   归属尚未导入打卡的号码布也可以（自动登记选手，等待读数，状态为无出发）。
3. 选手按**所属赛道**构造有效链，组/终点截止按所属赛道判定；停表与净耗时规则不变。
4. `rank` 保持**全场净耗时名次**；`groupRank` 只在**同组完赛者**中按净耗时计算且**允许并列**
   （未分组者同属默认赛道组）；**未完赛者两种名次均为空**。
5. 组别赛道与归属**整体替换、原子生效**：变动须携带 `expectedRevision`，过期返回 **409 + `currentRevision`**；
   **未知组别、重复归属、空替代点位**等任一非法 → **400 整次拒绝**（不部分写入）；
   提交内容与现有完全一致时为只读操作，**不推进修订号**。变更会推进修订号，从而**推动整案预演/确认
   （旧预演令牌立即过期）与实时成绩重算**。
6. **发布冻结**当时的组别赛道、归属与两种名次（`divisions_json` 快照、`published_result.group_rank` 落库）；
   之后再调整组别或归属，历史版本不变。
7. 旧数据库首次启动自动迁移：新建 `division` / `division_group` / `division_group_point` / `runner_division` 表，
   为历史 `publication` 回填空组别/空归属，为历史 `published_result` 回填
   `group_rank = rank_no`（旧版发布时无组别，所有完赛者同属默认赛道，组内名次即全场名次）；
   原有未分组调用（不设置组别）行为与之前完全一致。

### 组别赛道 HTTP 调用示例

```bash
# 1) 查询当前组别赛道、归属与修订号
curl -s http://localhost:3000/api/divisions
# -> { "configured": true, "revision": 5,
#      "divisions": [
#        { "code": "ME", "name": "男子精英组", "finishCutoff": 1800,
#          "groups": [ { "seq": 1, "name": "山脊组", "cutoffSecs": 600, "points": ["A1","A2"] },
#                      { "seq": 2, "name": "湖畔组", "cutoffSecs": 1200, "points": ["B1","B2"] } ] },
#        { "code": "WE", "name": "女子精英组", "finishCutoff": 1200,
#          "groups": [ { "seq": 1, "name": "近郊组", "cutoffSecs": 500, "points": ["C1","C2"] } ] } ],
#      "assignments": [ { "bib": "201", "divisionCode": "ME" },
#                       { "bib": "202", "divisionCode": "WE" } ] }

# 2) 整体替换组别赛道与归属（须携带 expectedRevision，原子生效）
curl -s -X POST http://localhost:3000/api/divisions \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedRevision": 5,
    "divisions": [
      { "code": "ME", "name": "男子精英组", "finishCutoff": 1800,
        "groups": [
          { "name": "山脊组", "cutoffSecs": 600,  "points": ["A1", "A2"] },
          { "name": "湖畔组", "cutoffSecs": 1200, "points": ["B1", "B2"] }
        ] },
      { "code": "OPEN", "name": "公开组", "finishCutoff": 1500,
        "groups": [ { "name": "打卡组", "cutoffSecs": 1000, "points": ["B1", "B2"] } ] }
    ],
    "assignments": [
      { "bib": "201", "divisionCode": "ME" },
      { "bib": "001", "divisionCode": "OPEN" }
    ]
  }'
# -> { "ok": true, "revision": 6, "changed": true, "divisions": [...], "assignments": [...] }
# 未出现在 assignments 中的号码布保持未分组（走默认赛道）；空 divisions 数组清除全部组别与归属。

# 3) 实时成绩同时返回全场名次与组内名次
curl -s http://localhost:3000/api/results
# -> { "divisions": [...], "assignments": [...], "results": [
#      { "bib":"201", "divisionCode":"ME", "divisionName":"男子精英组",
#        "status":"ok", "elapsed":1250, "netElapsed":1150, "rank":5, "groupRank":1, ... },
#      { "bib":"001", "divisionCode":null, "status":"ok",
#        "elapsed":910, "netElapsed":810, "rank":1, "groupRank":1, ... },
#      { "bib":"002", "status":"finish_dnf", "rank":null, "groupRank":null, ... } ] }

# 4) 整次拒绝与修订过期
# 未知组别：     400 { "error": "号码布 001 归属未知组别「XX」，整次拒绝" }
# 重复归属：     400 { "error": "号码布 001 重复归属，整次拒绝" }
# 空替代点位：   400 { "error": "组别「ME」组「山脊组」替代点位为空，整次拒绝" }
# 修订过期：     409 { "error": "赛事已修订，请刷新后重试", "currentRevision": 6 }
# 无变化保存：   200 { "ok": true, "changed": false, "revision": 6 }（不推进修订号）

# 5) 发布版冻结组别/归属/两种名次
curl -s -X POST http://localhost:3000/api/publications \
  -H 'Content-Type: application/json' -d '{"expectedRevision":6,"note":"组别冻结版"}'
curl -s http://localhost:3000/api/publications/3
# -> { "divisions": { "divisions": [...], "assignments": [...] },
#      "results": [ { "bib":"201", "rank":5, "groupRank":1, "divisionCode":"ME", ... } ] }
```

## 裁判操作（争议复核）

- **作废**打卡：填写原因，读数标记 voided 并不再参与核算；
- **更正**打卡：填写原因与新点位/新秒数（非负），系统保留原值、新值、原因、时间，并重算成绩。
- 作废/更正影响的是**当前实时成绩**；已发布版本不受影响。

### 整案申诉（预演 → 确认，两阶段原子提交）

同一申诉往往涉及**多条打卡**，可一次性组成「整案」处理：

1. 裁判为每条现有打卡逐条选择**作废**（仅填原因）或**更正**（原因 + 新点位 + **非负整数秒数**）；
   **已作废打卡不得再处理，同一打卡在同一整案中不得重复指定**。
2. 先调用**预演**：系统基于**当前赛事修订号**在内存中演练整案（**完全只读**——不改打卡、审计、修订号，
   也不碰历史发布版），返回：
   - 处理前/后每一名**受影响选手**的成绩、名次、状态、失败原因（失败组/超时秒数）与**有效链差异**
     （移出/纳入哪些记录）；
   - 受影响名单**包含仅因他人成绩变化而名次改变**的选手（标记 `direct:false`，其有效链差异为空）；
   - 一个签名 `token`，绑定「预演时修订号 + 规范化操作集合」。
3. 核对无误后再调用**确认**，携带相同的 `expectedRevision` 与预演返回的 `token`：
   - 赛事已被他人修订（修订号不一致）→ **HTTP 409 并返回 `currentRevision`**，必须重新预演；
   - token 缺失/非法/服务重启后失效、或确认时再次整案校验发现打卡缺失/已作废等 → **400 整案拒绝**；
   - 成功则**全部变更与逐条审计在一个事务内一次性落库，修订号只推进一次**，并返回最新成绩；
   - 任何失败都**不会部分生效**。
4. 已发布历史版保持冻结；首次入库原始读数（`orig_*`）仍用于重导判定，不受整案更正影响。
5. 现有单条作废/更正、批量导入、发布接口保持不变，与整案接口完全兼容。

## 发布冻结与赛事修订

- 每次关卡设置、组别赛道/归属变更、停表区间变动、批量导入（确有新增时）、作废/更正、发布都会推进赛事
  `revision` 修订号；导入全部为幂等跳过、停表或组别保存后内容无变化时为只读操作，不推进修订号。
- 导入、发布、停表配置与组别配置必须在请求中携带 `expectedRevision`；与当前修订不一致时返回
  **HTTP 409 及 `currentRevision`**（前端提示刷新），避免覆盖他人更改。
- 发布将**关卡配置 + 组别赛道与归属 + 停表区间 + 全部有效读数（作废读数除外）+ 当次成绩
  （含净耗时与两种名次）**整体快照写入 `publication` / `published_result` 表，版本号递增；
  历史版只读，后续更正/作废/重导/停表或组别调整**不修改任何历史版**。
- 批量导入校验：
  - 秒数必须为非负整数，出现**负秒数 → 整批拒绝**；
  - **同号异「原始内容」→ 整批拒绝**：同记录号判定以该记录号**首次入库时**的
    `bib / point / seconds / kind`（库内 `orig_*` 列）为准，**不看裁判更正后的现值**；
    批次内或与库中冲突均整体回滚，混有新记录时也**不会部分入库**；
  - 同号且与**首次入库原始读数**完全一致 → **幂等跳过**。

### 更正/作废后的重导语义（本轮修复）

设备重新上报原批次时常见两类误判，现按「首次入库原始读数」统一判定：

1. 记录已被**更正**（如 `A2@300` 更正为 `A1@250`）：原批次以原始读数 `A2@300` 再次导入时
   **幂等跳过**，不再因「与库中现值不一致」整批拒绝；跳过**绝不覆盖**更正现值、作废状态、
   作废原因与审计留痕。
2. 同号记录的读数恰好等于**更正后现值**但不同于原始读数（如上例以 `A1@250` 导入）：
   仍属于同号异原始内容，**整批拒绝**，不会被错误跳过。
3. 经历**多次更正**后，始终按**最初读数**比对（中间更正值不算）；实时成绩继续沿用
   **裁判现值**计算，已发布的历史版本保持冻结。
4. 已**作废**记录按原始读数重导同样跳过，且不会恢复为有效状态。

旧数据库首次启动时自动迁移：为历史打卡补记 `orig_*` 原始读数；曾更正的记录从最早一条
`correct` 审计回填最初读数，未更正的记录原值即现值。

导入数据格式（JSON 数组，或 `recordNo,bib,point,seconds,kind,name` 的 CSV/TSV）：

```json
[
  { "recordNo": "R1001", "bib": "007", "name": "周杰", "point": "S",  "seconds": 0,    "kind": "start" },
  { "recordNo": "R1002", "bib": "007", "point": "A1", "seconds": 320,  "kind": "enroute" },
  { "recordNo": "R1003", "bib": "007", "point": "B2", "seconds": 780,  "kind": "enroute" },
  { "recordNo": "R1004", "bib": "007", "point": "F",  "seconds": 1100, "kind": "finish" }
]
```

### HTTP 调用示例

先取当前修订号，再把它作为 `expectedRevision` 提交：

```bash
# 1) 查询当前修订号
curl -s http://localhost:3000/api/event
# -> { "configured": true, "revision": 3, ... }

# 2) 批量导入（JSON 数组）
curl -s -X POST http://localhost:3000/api/punches/import \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedRevision": 3,
    "punches": [
      { "recordNo": "R1001", "bib": "007", "point": "S",  "seconds": 0,    "kind": "start" },
      { "recordNo": "R1002", "bib": "007", "point": "A1", "seconds": 320,  "kind": "enroute" },
      { "recordNo": "R1003", "bib": "007", "point": "B2", "seconds": 780,  "kind": "enroute" },
      { "recordNo": "R1004", "bib": "007", "point": "F",  "seconds": 1100, "kind": "finish" }
    ]
  }'
# 成功：{ "ok": true, "inserted": 4, "skipped": 0, "revision": 4 }
# 全部幂等跳过：{ "ok": true, "inserted": 0, "skipped": 4, "revision": 4 }（修订号不变）

# 3) 原批次更正/作废后再次导入：与首次入库原始读数一致的记录幂等跳过，
#    新记录正常入库；冲突时整批 400（不会部分入库）
curl -s -X POST http://localhost:3000/api/punches/import \
  -H 'Content-Type: application/json' \
  -d '{ "expectedRevision": 4, "punches": [
        { "recordNo": "R1001", "bib": "007", "point": "S", "seconds": 0,   "kind": "start" },
        { "recordNo": "R1005", "bib": "007", "point": "F", "seconds": 999, "kind": "finish" }
      ]}'
# -> { "ok": true, "inserted": 1, "skipped": 1, "revision": 5 }

# 4) 修订号过期：HTTP 409 + currentRevision（以返回值为准刷新后重试）
#    HTTP/1.1 409 Conflict
# -> { "error": "赛事已修订，请刷新后重试", "currentRevision": 5 }

# 5) 同号异原始内容 / 负秒数：HTTP 400 整批拒绝（事务回滚，全部不入库）
# -> { "error": "记录号 R1003 已存在但原始内容不同，整批拒绝" }
```

其他常用接口：

```bash
# 实时成绩（沿用裁判更正后的现值；作废读数不参与；elapsed 为原始耗时，netElapsed 为净耗时）
curl -s http://localhost:3000/api/results

# 打卡与审计（含首次入库的 orig_point/orig_seconds 原始读数）
curl -s 'http://localhost:3000/api/punches?bib=007'

# 更正 / 作废（reason 必填，立即重算并推进修订，历史发布版不变）
curl -s -X POST http://localhost:3000/api/punches/12/correct \
  -H 'Content-Type: application/json' \
  -d '{"reason":"依据现场照片更正","newPoint":"A2","newSeconds":310}'
curl -s -X POST http://localhost:3000/api/punches/13/void \
  -H 'Content-Type: application/json' -d '{"reason":"设备重复上报"}'

# 发布冻结快照（同样需要 expectedRevision）/ 查看历史版
curl -s -X POST http://localhost:3000/api/publications \
  -H 'Content-Type: application/json' -d '{"expectedRevision":5,"note":"赛后冻结"}'
curl -s http://localhost:3000/api/publications/1
```

### 整案申诉 HTTP 调用示例

```bash
# 1) 先查当前修订号（也可从 /api/event 与 /api/results 顶部获取）
curl -s http://localhost:3000/api/event
# -> { "revision": 3, ... }

# 2) 预演整案（只读，不落库；punchId 来自 GET /api/punches?bib=090）
curl -s -X POST http://localhost:3000/api/appeals/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "expectedRevision": 3,
    "operations": [
      { "punchId": 42, "action": "void",
        "reason": "申诉成立：设备重复出发" },
      { "punchId": 43, "action": "correct",
        "reason": "申诉成立：点位/秒数笔误",
        "newPoint": "B1", "newSeconds": 500 },
      { "punchId": 44, "action": "correct",
        "reason": "申诉成立：终点读数有误",
        "newPoint": "F", "newSeconds": 650 }
    ]
  }'
# -> {
#      "ok": true, "revision": 3, "token": "<签名令牌>",
#      "affectedCount": 3,
#      "affected": [
#        { "bib": "090", "direct": true,  "changed": true,
#          "before": { "status": "bad_start", ... },
#          "after":  { "status": "ok", "elapsed": 650, "stoppedSecs": 100,
#                      "netElapsed": 550, "rank": 1, ... },
#          "chainDiff": { "added": [...], "removed": [...] } },
#        { "bib": "091", "direct": false, "changed": true,
#          "before": { "rank": 1, ... }, "after": { "rank": 2, ... },
#          "chainDiff": { "added": [], "removed": [] } }   // 仅名次联动
#      ]
#    }
# 预演不会改变 revision、打卡、审计与历史发布版。

# 3) 确认整案：绑定预演时修订号 + token；原子落库，修订只推进一次
curl -s -X POST http://localhost:3000/api/appeals/confirm \
  -H 'Content-Type: application/json' \
  -d '{ "expectedRevision": 3, "token": "<上一步返回的 token>" }'
# -> { "ok": true, "revision": 4, "auditCount": 3,
#      "committed": [ ...规范化后的操作集合... ],
#      "results": [ ...全部选手最新成绩（含名次）... ] }

# 4) 赛事在预演后被他人改动：409 + currentRevision，必须重新预演
# HTTP/1.1 409 Conflict
# -> { "error": "赛事已修订，请重新预演后再确认", "currentRevision": 4 }

# 5) 整案无效（重复指定/已作废/缺失打卡/负秒数/缺原因/token 伪造）：400 整案拒绝
# -> { "error": "打卡 #42 在同一申诉中被重复指定，整案拒绝" }
```

---

## 页面说明

- **成绩排名**：实时成绩、全场名次与组内名次（均含并列）、所属组别、状态、失败组/超时说明、
  原始耗时/停表扣减/净耗时、每人的最早有效链；可按组别/默认赛道筛选查看组内成绩。
- **组别赛道**：维护各组别的有序关卡组、可替代点位与关卡/终点截止，并按号码布指定选手组别
  （未分组者走默认赛道）；客户端即时校验（未知组别/重复归属/空替代点位整次拒绝），保存携带修订号原子生效。
- **停表区间**：整体维护距发枪秒数表示的停表区间（客户端即时校验、预览合并后的并集），保存携带修订号。
- **整案申诉**：按号码布挑选多条打卡组成同一申诉，逐条作废/更正并填原因；先预演查看所有受影响选手
  （含名次联动者）处理前后的成绩（原始/净耗时）、全场与组内名次、失败原因与有效链差异，再一次性原子确认。
- **争议复核**：按号码布查看打卡，执行单条作废/更正并查看完整操作留痕。
- **打卡导入**：批量粘贴导入，展示整批校验结果。
- **关卡设置**：维护起点/终点、终点截止、顺序关卡组、组内替代点位与组截止（默认赛道，未分组者使用）。
- **发布冻结**：发布新版本、浏览各历史冻结版的关卡/组别赛道与归属/停表区间/读数/成绩
  （含冻结的净耗时与两种名次）。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/event` | 当前赛事配置、默认赛道、组别赛道与归属、停表区间与修订号 |
| POST | `/api/setup` | 设置默认赛道关卡组（body 需 `expectedRevision`） |
| GET | `/api/divisions` | 当前组别赛道与选手归属、修订号 |
| POST | `/api/divisions` | 整体替换组别赛道与归属（需 `expectedRevision`；未知组别/重复归属/空替代点位 400 整次拒绝，过期 409；无变化不推进修订） |
| GET | `/api/stoppages` | 当前停表区间并集与修订号 |
| POST | `/api/stoppages` | 整体替换停表区间（需 `expectedRevision`；无效区间 400 整次拒绝，过期 409） |
| POST | `/api/punches/import` | 批量导入（按首次入库原始读数幂等；冲突整批拒绝，409 过期 / 400 拒绝） |
| GET | `/api/punches?bib=` | 打卡与审计记录 |
| POST | `/api/punches/:id/void` | 作废（reason 必填） |
| POST | `/api/punches/:id/correct` | 更正（newPoint/newSeconds/reason） |
| POST | `/api/appeals/preview` | 整案预演（只读，返回处理前后对比与签名 token；409 过期 / 400 整案无效） |
| POST | `/api/appeals/confirm` | 整案确认（expectedRevision + token；原子落库只推进一次修订，409 需重新预演） |
| GET | `/api/results` | 当前实时成绩排名（含 `elapsed`/`netElapsed`、全场名次 `rank` 与组内名次 `groupRank`、所属组别） |
| POST | `/api/publications` | 发布冻结快照（含组别赛道与归属、停表区间、两种名次，需 `expectedRevision`） |
| GET | `/api/publications` / `/api/publications/:version` | 版本列表 / 历史冻结版详情（含 `stoppages` 与 `divisions`） |

## 目录结构

```
server/            Express + better-sqlite3 后端
  src/index.mjs    API 路由（含整案申诉 /api/appeals/preview|confirm、停表区间 /api/stoppages、组别赛道 /api/divisions）
  src/appeals.mjs  整案操作校验、只读内存预演、签名令牌与原子提交
  src/scoring.mjs  按所属赛道的最早有效链、区间并集/交长、净耗时、全场名次与组内名次（支持内存读数核算）
  src/db.mjs       SQLite 连接/建表/修订号/旧库迁移（停表列回填、组别表与名次数列回填）
  src/seed.mjs     演示数据（含一段天气停表区间 500–600s、ME/WE 示范组别赛道与三名已归属选手）
  src/schema.sql   数据库表结构（stoppage_interval、division*、runner_division、
                   publication.stoppages_json/divisions_json、published_result.net_elapsed/group_rank）
  e2e-test.mjs     端到端断言（168 项，覆盖核算/整批拒绝/修订锁/冻结/重导语义/整案申诉/停表净耗时/组别赛道与组内名次）
web/               React + Vite 前端
  src/components/  八个功能页面（成绩/组别赛道/停表区间/整案申诉/单条复核/导入/设置/发布）
Dockerfile         多阶段构建（前端构建 + 后端 + 运行镜像）
docker-compose.yml 一键启动、建表、初始化数据，端口 3000
```

## 端到端测试

```bash
# 终端 1：干净数据库启动服务器
rm -f data/orienteering.db*
SEED=1 node server/src/index.mjs

# 终端 2：运行 168 项断言（含整案申诉预演/确认、停表净耗时、组别赛道与组内名次、冻结版不可变）
node server/e2e-test.mjs http://localhost:3000
```

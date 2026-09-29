# 矿区钻孔岩芯编目台（gbdrillcore）

面向地质勘查钻探班组与地质编录员：登记钻孔台帐、回次进尺与采取率、岩芯箱箱位，并按深度区间编录岩性描述与样品。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21811>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（holeStore / runStore / boxStore / lithoStore / reviewStore） |
| 存储 | IndexedDB（Dexie，库名 `gbdrillcore-db`，schema v3） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21811
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # drill-hole / drill-run / core-box / litho-log / seal-review
│       ├── stores/            # holeStore / runStore / boxStore / lithoStore / reviewStore
│       ├── components/common/ # DepthRangeInput / RecoveryBadge / BoxGrid / LithoColumn / StatBadge / FilterBar / EmptyPanel
│       ├── components/review/ # VersionChainModal / VersionHistoryButton / PendingReviewTag
│       ├── hooks/             # useHoleFilter / useDepthCalc
│       ├── pages/             # HoleBoard / HoleList / RunLog / CoreBoxList / LithoEditor / ReviewBoard
│       ├── router/index.tsx   # 路由表
│       └── utils/             # recovery.ts / db.ts / export.ts / versioning.ts / entityMeta.ts（+ seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 工作台 | 钻孔进度、设计达成率、未达设计待补勘清单、采取率异常清单（<75% 标红） |
| `/holes` | 钻孔台帐 | 建孔、坐标与孔口标高、设计/终孔深度、测斜数据、回次深度覆盖与岩芯箱数回显 |
| `/runs` | 回次记录 | 起止深度自动算进尺与采取率，低于 75% 立即标红并入异常清单 |
| `/boxes` | 岩芯箱编目 | 格位网格按深度填充、破损格标记、装箱深度连续性与格位容量校验 |
| `/lithology` | 岩性编录 | 按深度区间编录岩性/蚀变/矿化/RQD/样品，区间重叠报冲突并高亮，SVG 岩性柱状图 |
| `/review` | 封存复核 | 按钻孔+深度段封存钻孔/回次/岩芯箱/岩性，逐项对照旧版与当前值，采用生成新版本、退回恢复基线版，清理归档与版本链 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbdrillcore-db`），表：`holes`、`runs`、`boxes`、`lithos`、`seals`、`versions`、`sealItems`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为岩性表增加 `[holeId+fromDepth]` 复合索引并回填历史 RQD。
- `db.version(3).upgrade(...)` 增加封存复核三表（`seals`/`versions`/`sealItems`），并为存量钻孔、回次、岩芯箱、岩性各补一条 `init` 初始版本，旧结论不再丢失。升级前可用顶栏「导出备份」导出全量 JSON（含版本链）。
- 封存与版本链规则：
  - 按「钻孔 + 深度段」封存，与封存段相交的钻孔本体、回次、岩芯箱、岩性整体纳入；同孔深度段重叠且仍在复核中的封存会被拦截（端点相接不算重叠）。
  - 封存只固定复核基线，**不锁定原记录**：封存后仍可在各台账正常编辑修正。
  - 复核工作台按字段对照「封存旧版 vs 当前值」：**采用**以当前值生成新版本（`adopt`）；**退回**把封存基线写回并追加恢复版本（`return`）；范围外记录不受影响。
  - 清理涉及封存深度的记录走**软删除**（`deleted` 标记），版本链与查看入口保留，可在封存复核台「清理归档」查看或恢复；未封存记录仍物理删除。
  - 复核结论持久化在 IndexedDB，切换钻孔后待复核与差异状态仍在。
- 首次打开且表为空时写入一批示例编目数据（`src/utils/seed.ts`，5 个钻孔 + 回次 + 岩芯箱 + 岩性区间）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 本地自检（无后端）

封存版本链与 v2→v3 升级逻辑可用 `fake-indexeddb` 在 Node 下跑断言（不随容器构建）：

```bash
cd frontend
npm install
npx esbuild scripts/verify-versioning.mts --bundle --platform=node --format=esm --outfile=/tmp/v.mjs && node /tmp/v.mjs
npx esbuild scripts/verify-upgrade.mts   --bundle --platform=node --format=esm --outfile=/tmp/u.mjs && node /tmp/u.mjs
```

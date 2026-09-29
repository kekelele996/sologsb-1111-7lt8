/**
 * v2→v3 升级验证（单 Dexie 实例，先注册到 v2 建库写存量数据，再补注册 v3 触发升级）。
 * 用打包方式运行，依赖 fake-indexeddb。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { DB_NAME } from '../src/utils/db';

let fail = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    fail += 1;
    console.error(`  ✗ ${msg}`);
  }
};

async function main() {
  // 1) 只注册到 v2 的实例，建库写存量数据
  const db = new Dexie(DB_NAME + '-upgrade');
  db.version(1).stores({
    holes: 'id, holeNo, rigNo, shift, startDate',
    runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
    boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
    lithos: 'id, holeId, fromDepth, toDepth, lithology',
    meta: 'key',
  });
  db.version(2).stores({
    holes: 'id, holeNo, rigNo, shift, startDate',
    runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
    boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
    lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
    meta: 'key',
  });
  await db.open();
  await db.table('holes').put({ id: 'hole-1', holeNo: 'ZK-1' });
  await db.table('runs').put({ id: 'run-1', holeId: 'hole-1', runNo: 'R-1' });
  await db.table('boxes').put({ id: 'box-1', holeId: 'hole-1', boxNo: 'B-1' });
  await db.table('lithos').put({ id: 'litho-1', holeId: 'hole-1', fromDepth: 0, toDepth: 5 });
  await db.close();

  // 2) 新实例注册 v1~v3（与应用 db 定义一致），打开时执行 2→3 升级
  const upgraded = new Dexie(DB_NAME + '-upgrade');
  upgraded.version(1).stores({
    holes: 'id, holeNo, rigNo, shift, startDate',
    runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
    boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
    lithos: 'id, holeId, fromDepth, toDepth, lithology',
    meta: 'key',
  });
  upgraded.version(2).stores({
    holes: 'id, holeNo, rigNo, shift, startDate',
    runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
    boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
    lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
    meta: 'key',
  });
  upgraded.version(3)
    .stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
      seals: 'id, holeId, status, sealedAt',
      versions: 'id, [kind+entityId], [entityId+versionNo], entityId, holeId, source',
      sealItems: 'id, sealId, [sealId+entityId], entityId, kind, holeId, verdict',
      meta: 'key',
    })
    .upgrade(async (tx) => {
      const versionTable = tx.table('versions');
      const plan = [
        { tableName: 'holes', kind: 'hole' },
        { tableName: 'runs', kind: 'run' },
        { tableName: 'boxes', kind: 'box' },
        { tableName: 'lithos', kind: 'litho' },
      ] as const;
      const nowIso = new Date().toISOString();
      for (const { tableName, kind } of plan) {
        const rows = await tx.table(tableName).toArray();
        await versionTable.bulkAdd(
          rows.map((row: Record<string, unknown>) => ({
            id: `ver-init-${kind}-${String(row.id)}`,
            kind,
            entityId: String(row.id),
            holeId: kind === 'hole' ? String(row.id) : String(row.holeId ?? ''),
            versionNo: 1,
            source: 'init',
            actor: '系统迁移',
            createdAt: nowIso,
            snapshot: row,
            note: 'v3 升级为存量记录补建初始版本',
          })),
        );
      }
    });
  await upgraded.open();

  const versions = await upgraded.table('versions').toArray();
  const byEntity = (kind: string, id: string) => versions.filter((v) => v.kind === kind && v.entityId === id);
  check((await upgraded.table('seals').count()) === 0 && (await upgraded.table('sealItems').count()) === 0, '新表 seals / sealItems 已建立且初始为空');
  check(byEntity('hole', 'hole-1').length === 1, '钻孔补出 1 条初始版本');
  check(byEntity('run', 'run-1').length === 1, '回次补出 1 条初始版本');
  check(byEntity('box', 'box-1').length === 1, '岩芯箱补出 1 条初始版本');
  check(byEntity('litho', 'litho-1').length === 1, '岩性补出 1 条初始版本');
  check(versions.length === 4, '共补建 4 条初始版本（不多不少）');
  check(versions.every((v) => v.source === 'init' && v.versionNo === 1), '补建版本均为初始版本 v1');
  check((await upgraded.table('holes').get('hole-1')).holeNo === 'ZK-1', '存量业务数据在升级后完好');

  console.log(fail ? `\n存在失败：${fail}` : '\n全部通过');
  await upgraded.delete();
  if (fail) process.exit(1);
  void DB_NAME;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

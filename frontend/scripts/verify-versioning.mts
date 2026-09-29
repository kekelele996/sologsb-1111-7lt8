import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import {
  adoptItem,
  closeSeal,
  createSeal,
  deleteEntity,
  diffEntities,
  listVersions,
  listArchivedEntities,
  restoreEntity,
  returnItem,
  SealBlockedError,
  getEntity,
} from '../src/utils/versioning';
import type { DrillHole } from '../src/types/drill-hole';
import type { DrillRun } from '../src/types/drill-run';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${msg}`);
  }
}
async function expectThrow(fn: () => Promise<unknown>, fragment: string, msg: string) {
  try {
    await fn();
    fail += 1;
    console.error(`  ✗ ${msg}（未抛出）`);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes(fragment)) {
      pass += 1;
      console.log(`  ✓ ${msg}`);
    } else {
      fail += 1;
      console.error(`  ✗ ${msg}（错误信息不符：${message}）`);
    }
  }
}

async function seed() {
  const hole: DrillHole = {
    id: 'hole-t1',
    holeNo: 'ZK-T1',
    coordX: 1,
    coordY: 2,
    collarElevation: 100,
    designDepth: 200,
    finalDepth: 0,
    startDate: '2026-09-01T00:00:00.000Z',
    rigNo: 'XY-1',
    shift: '甲班',
    surveyData: [{ id: 'sv1', depth: 50, dip: 88, azimuth: 130 }],
  };
  const run: DrillRun = {
    id: 'run-t1',
    runNo: 'T1-01',
    holeId: 'hole-t1',
    fromDepth: 0,
    toDepth: 5,
    footage: 5,
    coreLength: 4.5,
    recovery: 90,
    waterLevel: 10,
    shift: '甲班',
    drilledAt: '2026-09-02T00:00:00.000Z',
    recorder: '张三',
  };
  const outside: DrillRun = { ...run, id: 'run-t2', runNo: 'T1-99', fromDepth: 100, toDepth: 105 };
  await db.holes.put(hole);
  await db.runs.bulkPut([run, outside]);
  return { hole, run, outside };
}

async function main() {
  await seed();

  // 旧数据补初始版本：v3 升级不会在 fresh DB（已是 v3）触发，封存时对未入链记录补 init
  const { seal: s1 } = await createSeal({ holeId: 'hole-t1', fromDepth: 0, toDepth: 50, sealedBy: '地质员甲', reason: '首段复核' });
  const runChain = await listVersions('run', 'run-t1');
  assert(runChain.length === 2, '封存为未入链记录补 init(v1) + seal(v2)');
  assert(runChain[0].source === 'init' && runChain[1].source === 'seal', '版本来源依次为初始版本、封存快照');
  const holeChain = await listVersions('hole', 'hole-t1');
  assert(holeChain.length === 2, '钻孔本体（无深度段）总是纳入封存');
  const outsideChain = await listVersions('run', 'run-t2');
  assert(outsideChain.length === 0, '范围外记录不动（100~105m 不纳入 0~50m 封存）');

  // 封存后原记录仍可修正
  const sealedRun = (await getEntity('run', 'run-t1'))! as DrillRun;
  const edited: DrillRun = { ...sealedRun, recorder: '李四', coreLength: 3.0, recovery: 60, footage: 5 };
  await db.runs.put(edited);

  const items = await db.sealItems.where('sealId').equals(s1.id).toArray();
  const runItem = items.find((i) => i.entityId === 'run-t1')!;
  const baseline = runChain[1].snapshot as DrillRun;
  const current = (await getEntity('run', 'run-t1'))!;
  const diffs = diffEntities('run', baseline, current);
  assert(diffs.some((d) => d.key === 'recorder'), '工作台能对照出改动字段（记录人）');
  assert(diffs.some((d) => d.key === 'recovery'), '工作台能对照出改动字段（采取率）');

  // 重叠范围复核未结束时拦截
  await expectThrow(
    () => createSeal({ holeId: 'hole-t1', fromDepth: 40, toDepth: 80, sealedBy: '地质员甲' }),
    '仍在复核中',
    '重叠深度段在复核结束前被拦截',
  );
  // 端点相接不拦截但 0~50 与 50~90 相接 → 可封存；先验相接不拦截
  const { seal: s1b } = await createSeal({ holeId: 'hole-t1', fromDepth: 50, toDepth: 90, sealedBy: '地质员甲' });
  assert(!!s1b.id, '端点相接（50m）不算重叠，可再次封存');

  // 退回：恢复封存基线（旧值）
  await returnItem(runItem.id, '复核人甲');
  const afterReturn = (await getEntity('run', 'run-t1')) as DrillRun;
  assert(afterReturn.recorder === '张三', '退回恢复封存基线（记录人 张三）');
  assert(afterReturn.recovery === 90, '退回恢复派生值（采取率 90）');
  const chainAfterReturn = await listVersions('run', 'run-t1');
  assert(chainAfterReturn[chainAfterReturn.length - 1].source === 'return', '退回追加 return 版本');
  const returnedItem = await db.sealItems.get(runItem.id);
  assert(returnedItem!.verdict === 'returned', '复核项结论为已退回');

  // 再改一次 → 已退回项出现新差异，可重新采用
  await db.runs.put({ ...afterReturn, recorder: '王五' });
  const current2 = (await getEntity('run', 'run-t1'))!;
  const chainForBaseline = await listVersions('run', 'run-t1');
  const baseline2 = chainForBaseline.find((v) => v.versionNo === runItem.baseVersionNo)!.snapshot as DrillRun;
  const diffs2 = diffEntities('run', baseline2, current2);
  assert(diffs2.some((d) => d.key === 'recorder' && String(d.newValue).includes('王五')), '结论后再改动能再次检出差异');

  // 采用：生成新版本
  await adoptItem(runItem.id, '复核人甲');
  const afterAdopt = (await getEntity('run', 'run-t1')) as DrillRun;
  assert(afterAdopt.recorder === '王五', '采用保留当前值（王五）');
  const chainAfterAdopt = await listVersions('run', 'run-t1');
  assert(chainAfterAdopt[chainAfterAdopt.length - 1].source === 'adopt', '采用生成 adopt 新版本');

  // 清理：有版本链 → 软删除，链保留
  const mode = await deleteEntity('run', 'run-t1');
  assert(mode === 'soft', '涉及封存深度的记录清理走软删除');
  const archived = await listArchivedEntities();
  assert(archived.some((a) => a.row.id === 'run-t1'), '软删除记录保留在归档查看入口');
  const archivedRun = (await getEntity('run', 'run-t1')) as DrillRun & { deleted?: boolean };
  assert(archivedRun.deleted === true, '台账记录被置 deleted 标记');

  // 未封存记录物理删除
  const mode2 = await deleteEntity('run', 'run-t2');
  assert(mode2 === 'hard' && !(await getEntity('run', 'run-t2')), '未封存记录仍为物理删除');

  // 归档恢复
  await restoreEntity('run', 'run-t1', '复核人甲');
  const restored = (await getEntity('run', 'run-t1')) as DrillRun & { deleted?: boolean };
  assert(!restored.deleted && restored.recorder === '王五', '归档恢复取最近非删除快照并清除删除态');
  assert((await listVersions('run', 'run-t1')).at(-1)!.source === 'restore', '恢复追加 restore 版本');

  // 结束复核后，重叠封存不再被拦截
  await closeSeal(s1.id);
  const { seal: s2 } = await createSeal({ holeId: 'hole-t1', fromDepth: 0, toDepth: 30, sealedBy: '地质员乙' });
  assert(!!s2.id, '复核结束后重叠深度段可再次封存');

  // 软删除态 diff
  await deleteEntity('run', 'run-t1');
  const s2Items = await db.sealItems.where('sealId').equals(s2.id).toArray();
  const s2RunItem = s2Items.find((i) => i.entityId === 'run-t1');
  if (s2RunItem) {
    const s2Chain = await listVersions('run', 'run-t1');
    const s2Base = s2Chain.find((v) => v.versionNo === s2RunItem.baseVersionNo)!.snapshot as DrillRun;
    const dDel = diffEntities('run', s2Base, (await getEntity('run', 'run-t1'))!);
    assert(dDel.some((d) => d.deleted), '删除态在对照中整体标记为已清理');
  } else {
    fail += 1;
    console.error('  ✗ 新封存应仍纳入软删除记录（区间相交）');
  }

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  await db.delete();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

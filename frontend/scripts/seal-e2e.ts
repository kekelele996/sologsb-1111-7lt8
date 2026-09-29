// 端到端逻辑验证（Node + fake-indexeddb），不依赖浏览器/DOM
import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import { backfillInitialVersions } from '../src/utils/versions';
import {
  batchAdopt,
  blockingSeals,
  closeSeal,
  createSeal,
  decideItem,
  deleteEntity,
  deleteHoleCascade,
  previewSeal,
} from '../src/utils/sealService';
import { uid } from '../src/utils/id';

let pass = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
  }
}

async function seed() {
  const hole = {
    id: 'hole-t', holeNo: 'ZK-T1', coordX: 1, coordY: 2, collarElevation: 100,
    designDepth: 100, finalDepth: 0, startDate: '2026-09-01T00:00:00Z', rigNo: 'XY-1',
    shift: '甲班', surveyData: [],
  } as never;
  await db.holes.put(hole);
  const runs = [];
  for (let i = 0; i < 4; i++) {
    runs.push({
      id: `run-${i}`, runNo: `R${i}`, holeId: 'hole-t', fromDepth: i * 5, toDepth: (i + 1) * 5,
      footage: 5, coreLength: 4.5, recovery: 90, waterLevel: 10, shift: '甲班',
      drilledAt: '2026-09-02T00:00:00Z', recorder: 'rec',
    });
  }
  await db.runs.bulkPut(runs as never[]);
  const box = {
    id: 'box-t', boxNo: 'B1', holeId: 'hole-t', fromDepth: 0, toDepth: 20, slots: 8,
    slotLength: 2.5, boxedAt: '2026-09-03T00:00:00Z', shelfPos: 'A 区 1 架', damagedSlots: [], operator: 'op',
  };
  await db.boxes.put(box as never);
  const litho = {
    id: 'litho-t', holeId: 'hole-t', fromDepth: 0, toDepth: 10, lithology: '花岗闪长岩',
    color: '灰白', alteration: '无', mineralization: '无', rqd: 80, sampleNo: '', logger: 'log',
  };
  await db.lithos.put(litho as never);
}

async function main() {
  await seed();

  console.log('1) 旧数据补初始版本（幂等）');
  const n1 = await backfillInitialVersions();
  const n2 = await backfillInitialVersions();
  check('首次回填为每条记录补 v1', n1 === 7, `n1=${n1}`); // 1 hole + 4 runs + 1 box + 1 litho
  check('再次回填不重复', n2 === 0, `n2=${n2}`);
  const chain0 = await db.versions.where('[entityType+entityId]').equals(['run', 'run-0']).toArray();
  check('初始版本 action=initial 且 v1', chain0.length === 1 && chain0[0].versionNo === 1 && chain0[0].action === 'initial');

  console.log('2) 封存 0~12m，包含整孔 + 重叠的回次/箱/岩性');
  const preview = await previewSeal({ holeId: 'hole-t', fromDepth: 0, toDepth: 12, sealedBy: '封存员', reviewer: '复核员' });
  check('预检包含钻孔(整孔)', preview.items.some((i) => i.entityType === 'hole' && i.scopeRange === '整孔'));
  check('预检包含 3 个回次 (0-5,5-10,10-15)', preview.items.filter((i) => i.entityType === 'run').length === 3);
  check('预检包含岩性', preview.items.some((i) => i.entityType === 'litho'));
  check('预检包含岩芯箱', preview.items.some((i) => i.entityType === 'box'));
  check('无重叠拦截', preview.blocking.length === 0);

  const seal = await createSeal({ holeId: 'hole-t', fromDepth: 0, toDepth: 12, sealedBy: '封存员', reviewer: '复核员' });
  check('封存单为 open', seal.status === 'open');
  const sealItems = await db.reviewItems.where('sealId').equals(seal.id).toArray();
  check('封存项数 = 6 (1 hole + 3 runs + box + litho)', sealItems.length === 6, `got ${sealItems.length}`);
  const run0Item = sealItems.find((i) => i.entityId === 'run-0')!;
  check('封存项记录封存版本号 v2', run0Item.sealedVersionNo === 2, `v=${run0Item.sealedVersionNo}`);

  console.log('3) 重叠范围尚未结束复核时先拦住');
  const block = await blockingSeals('hole-t', 10, 30);
  check('预检发现重叠封存', block.length === 1 && block[0].seal.id === seal.id);
  let blocked = false;
  try {
    await createSeal({ holeId: 'hole-t', fromDepth: 10, toDepth: 30, sealedBy: 'a', reviewer: 'b' });
  } catch {
    blocked = true;
  }
  check('重叠封存被拒绝', blocked);
  // 不重叠（相接不算重叠）应允许
  let edgeOk = true;
  try {
    await createSeal({ holeId: 'hole-t', fromDepth: 12, toDepth: 16, sealedBy: 'a', reviewer: 'b' });
  } catch (e) {
    edgeOk = false;
    console.log('   相接段封存意外失败:', (e as Error).message);
  }
  check('端点相接(12~16)不视为重叠，可封存', edgeOk);

  console.log('4) 封存后原记录仍可修正（不产生版本，差异留给复核）');
  const before = await db.runs.get('run-0');
  await db.runs.put({ ...before, coreLength: 2.0, recovery: 40 });
  const chainAfterEdit = await db.versions.where('[entityType+entityId]').equals(['run', 'run-0']).toArray();
  check('封存后编辑不新增版本（仍为 initial+seal = 2 版）', chainAfterEdit.length === 2, `len=${chainAfterEdit.length}`);

  console.log('5) 复核：退回恢复上一版；采用生成新版本');
  // 退回 run-0：coreLength 应恢复为 4.5，并追加 reject 版本
  await decideItem(run0Item.id, 'reject', '复核员', '数据有误退回');
  const restoredRun0 = await db.runs.get('run-0');
  check('退回后活动记录恢复封存值 coreLength=4.5', restoredRun0.coreLength === 4.5);
  check('退回后采取率恢复 90', restoredRun0.recovery === 90);
  const rejectedItem = await db.reviewItems.get(run0Item.id);
  check('退回项状态 rejected', rejectedItem!.status === 'rejected' && rejectedItem!.finalVersionNo === 3);

  // 采用一个改动项：改 run-1 再采用
  const r1Item = sealItems.find((i) => i.entityId === 'run-1')!;
  const r1 = await db.runs.get('run-1');
  await db.runs.put({ ...r1, coreLength: 3.0, recovery: 60 });
  await decideItem(r1Item.id, 'adopt', '复核员');
  const adoptedR1 = await db.runs.get('run-1');
  check('采用后当前值保留 coreLength=3.0', adoptedR1.coreLength === 3.0);
  const r1Chain = await db.versions.where('[entityType+entityId]').equals(['run', 'run-1']).sortBy('versionNo');
  check('采用产生 v3 adopt 且快照为当前值', r1Chain.length === 3 && r1Chain[2].action === 'adopt' && r1Chain[2].snapshot.coreLength === 3.0);

  // 采用一个未改动项：不产新版本，仅确认
  const sameItem = sealItems.find((i) => i.entityType === 'box')!;
  const boxChainBefore = await db.versions.where('[entityType+entityId]').equals(['box', 'box-t']).count();
  await decideItem(sameItem.id, 'adopt', '复核员');
  const boxChainAfter = await db.versions.where('[entityType+entityId]').equals(['box', 'box-t']).count();
  check('未改动项采用不产新版本', boxChainBefore === boxChainAfter);
  const sameDecided = await db.reviewItems.get(sameItem.id);
  check('未改动项状态仍为 adopted', sameDecided!.status === 'adopted' && sameDecided!.finalVersionNo === undefined);

  console.log('6) 清理涉及封存深度的记录 → 软删除保留链；范围外记录物理删除');
  // run-2 在封存范围内（10-15 与 0-12 重叠）
  const modeSoft = await deleteEntity('run', 'run-2');
  check('封存范围内删除 = soft', modeSoft === 'soft');
  const r2tomb = await db.runs.get('run-2');
  check('软删除墓碑仍存在且带 deletedAt', !!r2tomb && !!r2tomb.deletedAt);
  const r2chain = await db.versions.where('[entityType+entityId]').equals(['run', 'run-2']).count();
  check('软删除后版本链仍在', r2chain >= 2);
  // 对软删除项采用 → 墓碑版本固定
  const r2Item = sealItems.find((i) => i.entityId === 'run-2')!;
  await decideItem(r2Item.id, 'adopt', '复核员', '确认清理');
  const r2Chain2 = await db.versions.where('[entityType+entityId]').equals(['run', 'run-2']).sortBy('versionNo');
  check('采用清理结论追加墓碑 adopt 版本', r2Chain2[r2Chain2.length - 1].action === 'adopt' && !!r2Chain2[r2Chain2.length - 1].snapshot.deletedAt);

  // run-3 (15-20) 不在 seal(0-12)，但在相接封存(12-16)? run3 15-20 与 12-16 重叠 → 也被引用
  // 取一个确定范围外的：新建 run 30-35 未封存
  await db.runs.put({
    id: 'run-out', runNo: 'ROUT', holeId: 'hole-t', fromDepth: 30, toDepth: 35, footage: 5,
    coreLength: 4, recovery: 80, waterLevel: 1, shift: '甲班', drilledAt: '2026-09-02T00:00:00Z', recorder: 'x',
  } as never);
  await backfillInitialVersions();
  const modeHard = await deleteEntity('run', 'run-out');
  check('范围外（未封存）记录删除 = hard', modeHard === 'hard');
  check('物理删除后记录不存在', (await db.runs.get('run-out')) === undefined);
  check('物理删除后版本链清空', (await db.versions.where('[entityType+entityId]').equals(['run', 'run-out']).count()) === 0);

  console.log('7) 软删除记录退回 → 恢复（取消墓碑）');
  // 找一个软删除且 pending 的：用 litho
  const lithoItem = sealItems.find((i) => i.entityType === 'litho')!;
  await deleteEntity('litho', 'litho-t');
  check('岩性软删除', !!(await db.lithos.get('litho-t'))?.deletedAt);
  await decideItem(lithoItem.id, 'reject', '复核员');
  const lithoRestored = await db.lithos.get('litho-t');
  check('退回后岩性恢复且无 deletedAt', !!lithoRestored && !lithoRestored.deletedAt);

  console.log('8) 结束复核：有未处理项时拦住；全部处理后可关闭');
  // 还有 hole 项 pending
  let closeBlocked = false;
  try {
    await closeSeal(seal.id);
  } catch {
    closeBlocked = true;
  }
  check('存在 pending 时结束复核被拦', closeBlocked);
  // 批量采用剩余 pending（相接封存 run-3 也可能 pending，但只针对 seal.id）
  const remain = await db.reviewItems.where('sealId').equals(seal.id).filter((i) => i.status === 'pending').toArray();
  for (const it of remain) await decideItem(it.id, 'adopt', '复核员');
  await closeSeal(seal.id);
  const closed = await db.seals.get(seal.id);
  check('全部处理后封存单 closed', closed!.status === 'closed' && !!closed!.reviewedAt);

  console.log('9) 已结束复核的封存不再拦截重叠');
  const blockAfter = await blockingSeals('hole-t', 0, 12);
  check('closed 封存不产生拦截', blockAfter.length === 0);
  let overlapOk = true;
  try {
    await createSeal({ holeId: 'hole-t', fromDepth: 0, toDepth: 8, sealedBy: 'a', reviewer: 'b' });
  } catch {
    overlapOk = false;
  }
  check('复核结束后重叠段可重新封存', overlapOk);

  console.log('10) 批量采用');
  const s3 = await createSeal({ holeId: 'hole-t', fromDepth: 16, toDepth: 19, sealedBy: 'a', reviewer: 'b' }).catch(() => null);
  // 16-19 范围内可能没有活动记录（run3 15-20 被第二张封存 12-16? 不重叠16-19, run3 仍活动）→ run-3 重叠
  if (s3) {
    const cnt = await batchAdopt(s3.id, '复核员');
    const pend = await db.reviewItems.where('sealId').equals(s3.id).filter((i) => i.status === 'pending').count();
    check('批量采用处理全部 pending', cnt >= 1 && pend === 0, `cnt=${cnt}`);
  } else {
    check('批量采用场景封存创建成功（跳过）', false);
  }

  console.log('11) 删除钻孔级联：涉及封存 → 软删除，链保留');
  const mode = await deleteHoleCascade('hole-t');
  check('有封存单的孔删除为 soft', mode === 'soft');
  const holeTomb = await db.holes.get('hole-t');
  check('钻孔软删除墓碑存在', !!holeTomb && !!holeTomb.deletedAt);
  const holeChain = await db.versions.where('[entityType+entityId]').equals(['hole', 'hole-t']).count();
  check('钻孔版本链保留', holeChain >= 2);

  console.log(`\n通过 ${pass} 项检查`);
  await db.delete();
  void uid;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

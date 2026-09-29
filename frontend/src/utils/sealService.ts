import type { Table } from 'dexie';
import dayjs from 'dayjs';
import { db } from './db';
import { uid } from './id';
import { overlapRange, rangesOverlap, validateRange } from './recovery';
import { appendVersion, getLiveRow } from './versions';
import type { CoreBox } from '../types/core-box';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import type { EntityRow, EntityType, ReviewItem, Seal, VersionRecord } from '../types/seal';

/** 封存输入 */
export interface SealInput {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  sealedBy: string;
  reviewer: string;
  remark?: string;
}

/** 封存预检结果（创建前展示将封存的记录） */
export interface SealPreview {
  items: Array<{ entityType: EntityType; entityId: string; label: string; scopeRange: string }>;
  /** 与未结束复核封存的重叠冲突 */
  blocking: Array<{ seal: Seal; from: number; to: number }>;
}

/* ---------------- 类型安全的活动表写入（联合类型 -> 各表具体类型） ---------------- */

function putRow(type: EntityType, row: EntityRow): Promise<unknown> {
  switch (type) {
    case 'hole':
      return db.holes.put(row as DrillHole);
    case 'run':
      return db.runs.put(row as DrillRun);
    case 'box':
      return db.boxes.put(row as CoreBox);
    case 'litho':
      return db.lithos.put(row as LithoLog);
  }
}

/* ---------------- 数据变更事件：决定/清理后刷新四个业务 store ---------------- */

type ChangeHandler = () => void;
const changeHandlers = new Set<ChangeHandler>();

export function onDataChanged(handler: ChangeHandler): () => void {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}

function emitDataChanged(): void {
  changeHandlers.forEach((handler) => handler());
}

/* ---------------- 范围匹配与展示 ---------------- */

/** 记录在封存深度段内的重叠范围（钻孔记录整孔纳入，返回 null 表示不纳入） */
function scopeOf(type: EntityType, row: EntityRow, holeId: string, from: number, to: number): string | null {
  if ('holeId' in row && row.holeId !== holeId) return null;
  if (type === 'hole') {
    return row.id === holeId ? '整孔' : null;
  }
  const r = row as { fromDepth: number; toDepth: number };
  const overlap = overlapRange(from, to, r.fromDepth, r.toDepth);
  return overlap ? `${overlap.from}~${overlap.to}m` : null;
}

export function entityLabel(type: EntityType, row: EntityRow): string {
  switch (type) {
    case 'hole':
      return String((row as DrillHole).holeNo ?? row.id);
    case 'run':
      return String((row as DrillRun).runNo ?? row.id);
    case 'box':
      return String((row as CoreBox).boxNo ?? row.id);
    case 'litho':
      return `${(row as LithoLog).fromDepth}~${(row as LithoLog).toDepth}m`;
  }
}

async function collectRows(holeId: string): Promise<Array<{ type: EntityType; row: EntityRow }>> {
  const [hole, runs, boxes, lithos] = await Promise.all([
    db.holes.get(holeId) as Promise<DrillHole | undefined>,
    db.runs.where('holeId').equals(holeId).toArray(),
    db.boxes.where('holeId').equals(holeId).toArray(),
    db.lithos.where('holeId').equals(holeId).toArray(),
  ]);
  const all: Array<{ type: EntityType; row: EntityRow }> = [];
  if (hole && !hole.deletedAt) all.push({ type: 'hole', row: hole as EntityRow });
  runs.filter((r) => !r.deletedAt).forEach((row) => all.push({ type: 'run', row }));
  boxes.filter((r) => !r.deletedAt).forEach((row) => all.push({ type: 'box', row }));
  lithos.filter((r) => !r.deletedAt).forEach((row) => all.push({ type: 'litho', row }));
  return all;
}

/** 同孔未结束复核（open）且深度重叠的封存 */
export async function blockingSeals(
  holeId: string,
  from: number,
  to: number,
): Promise<Array<{ seal: Seal; from: number; to: number }>> {
  const open = await db.seals.where('holeId').equals(holeId).filter((s) => s.status === 'open').toArray();
  const blocking: Array<{ seal: Seal; from: number; to: number }> = [];
  open.forEach((seal) => {
    const overlap = overlapRange(from, to, seal.fromDepth, seal.toDepth);
    if (overlap) blocking.push({ seal, from: overlap.from, to: overlap.to });
  });
  return blocking;
}

/** 预检：列出将封存的记录与重叠拦截情况 */
export async function previewSeal(input: SealInput): Promise<SealPreview> {
  const rows = await collectRows(input.holeId);
  const items = rows
    .map(({ type, row }) => {
      const scopeRange = scopeOf(type, row, input.holeId, input.fromDepth, input.toDepth);
      return scopeRange
        ? { entityType: type, entityId: row.id, label: entityLabel(type, row), scopeRange }
        : null;
    })
    .filter((x): x is SealPreview['items'][number] => x !== null);
  return { items, blocking: await blockingSeals(input.holeId, input.fromDepth, input.toDepth) };
}

/* ---------------- 创建封存 ---------------- */

/**
 * 创建封存：重叠范围尚未结束复核时先拦住；
 * 通过后为范围内每项追加「封存」版本并保存快照，封存后原记录仍可修正。
 */
export async function createSeal(input: SealInput): Promise<Seal> {
  const from = Number(input.fromDepth);
  const to = Number(input.toDepth);
  const rangeError = validateRange(from, to);
  if (rangeError) throw new Error(rangeError);

  const hole = await db.holes.get(input.holeId);
  if (!hole || hole.deletedAt) throw new Error('所选钻孔不存在或已清理，无法封存');

  const blocking = await blockingSeals(input.holeId, from, to);
  if (blocking.length) {
    const detail = blocking.map((b) => `${b.seal.sealNo}（${b.from}~${b.to}m 仍在复核）`).join('；');
    throw new Error(`封存深度与尚未结束复核的封存重叠：${detail}。请先完成该封存的复核或调整深度段`);
  }

  const sealId = uid('seal');
  const sealCount = await db.seals.count();
  const seal: Seal = {
    id: sealId,
    sealNo: `FC-${dayjs().format('YYYYMMDD')}-${String(sealCount + 1).padStart(3, '0')}`,
    holeId: input.holeId,
    holeNo: hole.holeNo,
    fromDepth: from,
    toDepth: to,
    sealedBy: input.sealedBy.trim(),
    reviewer: input.reviewer.trim(),
    remark: input.remark?.trim() || undefined,
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  await db.transaction(
    'rw',
    [db.seals, db.reviewItems, db.versions, db.holes, db.runs, db.boxes, db.lithos],
    async () => {
      // 事务内重新检查，避免并发窗口产生重叠封存
      const open = await db.seals
        .where('holeId')
        .equals(input.holeId)
        .filter((s) => s.status === 'open')
        .toArray();
      if (open.some((s) => rangesOverlap(from, to, s.fromDepth, s.toDepth))) {
        throw new Error('封存深度与尚未结束复核的封存重叠，已拦截');
      }

      const rows = await collectRows(input.holeId);
      const items: ReviewItem[] = [];
      for (const { type, row } of rows) {
        const scopeRange = scopeOf(type, row, input.holeId, from, to);
        if (!scopeRange) continue;
        const version = await appendVersion({
          entityType: type,
          entityId: row.id,
          action: 'seal',
          snapshot: row,
          sealId,
          actor: seal.sealedBy,
          note: `封存单 ${seal.sealNo}（${from}~${to}m）`,
        });
        items.push({
          id: uid('rit'),
          sealId,
          entityType: type,
          entityId: row.id,
          label: entityLabel(type, row),
          scopeRange,
          sealedVersionNo: version.versionNo,
          snapshot: JSON.parse(JSON.stringify(row)) as EntityRow,
          status: 'pending',
        });
      }
      if (items.length === 0) throw new Error('该深度段内没有可封存的记录');
      await db.seals.put(seal);
      await db.reviewItems.bulkPut(items);
    },
  );

  return seal;
}

/* ---------------- 逐项复核：采用 / 退回 ---------------- */

export type Decision = 'adopt' | 'reject';

/**
 * 逐项决定：
 * - 采用：以当前值生成新版本；当前为「已清理」时以墓碑版本固定清理结论；封存后未改动则直接确认不产版本；
 * - 退回：把封存快照恢复为活动记录（撤销改动 / 恢复被清理记录），并追加「退回」版本。
 * 范围外记录不在复核项中，不会被触碰。
 */
export async function decideItem(
  itemId: string,
  decision: Decision,
  actor: string,
  note?: string,
): Promise<ReviewItem> {
  const item = await db.reviewItems.get(itemId);
  if (!item) throw new Error('复核项不存在');
  if (item.status !== 'pending') throw new Error('该复核项已处理');
  const seal = await db.seals.get(item.sealId);
  if (!seal) throw new Error('封存单不存在');
  if (seal.status !== 'open') throw new Error('该封存复核已结束');

  let finalVersionNo: number | undefined;

  await db.transaction('rw', [db.reviewItems, db.versions, db.holes, db.runs, db.boxes, db.lithos], async () => {
    const live = await getLiveRow(item.entityType, item.entityId);

    if (decision === 'adopt') {
      if (live) {
        if (live.deletedAt) {
          // 当前记录已被清理：采用清理结论，固定墓碑版本
          const version = await appendVersion({
            entityType: item.entityType,
            entityId: item.entityId,
            action: 'adopt',
            snapshot: live,
            sealId: seal.id,
            actor,
            note: note?.trim() || `采用清理结论（${seal.sealNo}）`,
          });
          finalVersionNo = version.versionNo;
        } else {
          const changed = JSON.stringify({ ...live, deletedAt: undefined }) !== JSON.stringify(item.snapshot);
          if (changed) {
            // 有改动：当前值即新版本，活动表保持当前值不变
            const version = await appendVersion({
              entityType: item.entityType,
              entityId: item.entityId,
              action: 'adopt',
              snapshot: live,
              sealId: seal.id,
              actor,
              note: note?.trim() || `复核采用当前值（${seal.sealNo}）`,
            });
            finalVersionNo = version.versionNo;
          }
          // 未改动：直接确认，不产生重复版本
        }
      }
    } else {
      // 退回：恢复上一版（封存快照），覆盖当前值 / 撤销软删除
      const restored = JSON.parse(JSON.stringify(item.snapshot)) as EntityRow;
      delete restored.deletedAt;
      await putRow(item.entityType, restored);
      const version = await appendVersion({
        entityType: item.entityType,
        entityId: item.entityId,
        action: 'reject',
        snapshot: restored,
        sealId: seal.id,
        actor,
        note: note?.trim() || `复核退回，恢复封存版 v${item.sealedVersionNo}（${seal.sealNo}）`,
      });
      finalVersionNo = version.versionNo;
    }

    const next: ReviewItem = {
      ...item,
      status: decision === 'adopt' ? 'adopted' : 'rejected',
      decidedBy: actor,
      decidedAt: new Date().toISOString(),
      finalVersionNo,
    };
    await db.reviewItems.put(next);
  });

  emitDataChanged();
  return (await db.reviewItems.get(itemId)) as ReviewItem;
}

/** 批量采用：封存后有改动或已清理的逐项采用；未改动项直接确认 */
export async function batchAdopt(sealId: string, actor: string): Promise<number> {
  const items = await db.reviewItems.where('sealId').equals(sealId).toArray();
  const pending = items.filter((item) => item.status === 'pending');
  let count = 0;
  // 逐项走同一套决定逻辑（事务粒度小，失败不影响其余项）
  for (const item of pending) {
    await decideItem(item.id, 'adopt', actor, '批量采用');
    count += 1;
  }
  return count;
}

/** 结束复核：全部项处理完毕后封存单关闭，此后不再拦截重叠封存，仅保留查看入口 */
export async function closeSeal(sealId: string): Promise<void> {
  const seal = await db.seals.get(sealId);
  if (!seal) throw new Error('封存单不存在');
  if (seal.status === 'closed') return;
  const pending = await db.reviewItems
    .where('sealId')
    .equals(sealId)
    .filter((i) => i.status === 'pending')
    .count();
  if (pending > 0) throw new Error(`还有 ${pending} 项未复核，无法结束复核`);
  await db.seals.put({ ...seal, status: 'closed', reviewedAt: new Date().toISOString() });
  emitDataChanged();
}

/* ---------------- 清理（删除）：保留版本链与查看入口 ---------------- */

/**
 * 清理单条记录：
 * - 凡被任一封存项引用（涉及封存深度）→ 软删除墓碑，版本链与复核查看入口全部保留；
 * - 未涉及封存 → 物理删除并清掉其版本链。
 */
export async function deleteEntity(type: EntityType, id: string): Promise<'soft' | 'hard'> {
  let result: 'soft' | 'hard' = 'hard';
  await db.transaction('rw', [db.holes, db.runs, db.boxes, db.lithos, db.versions, db.reviewItems], async () => {
    const itemCount = await db.reviewItems.where('[entityType+entityId]').equals([type, id]).count();
    const row = await getLiveRow(type, id);
    if (!row) return;
    if (itemCount > 0) {
      if (!row.deletedAt) {
        await putRow(type, { ...row, deletedAt: new Date().toISOString() });
      }
      result = 'soft';
    } else {
      const table = { hole: db.holes, run: db.runs, box: db.boxes, litho: db.lithos }[type] as Table<EntityRow, string>;
      await table.delete(id);
      await db.versions.where('[entityType+entityId]').equals([type, id]).delete();
      result = 'hard';
    }
  });
  emitDataChanged();
  return result;
}

/**
 * 删除钻孔（级联回次/岩芯箱/岩性）：
 * 只要该孔存在封存单，钻孔走软删除；子记录同样按「是否涉及封存」分别软删 / 物理删除。
 */
export async function deleteHoleCascade(holeId: string): Promise<'soft' | 'hard'> {
  let result: 'soft' | 'hard' = 'hard';
  await db.transaction(
    'rw',
    [db.holes, db.runs, db.boxes, db.lithos, db.versions, db.reviewItems, db.seals],
    async () => {
      const hole = await db.holes.get(holeId);
      if (!hole) return;
      const sealCount = await db.seals.where('holeId').equals(holeId).count();
      const softHole = sealCount > 0;

      const children: Array<{ type: Exclude<EntityType, 'hole'>; rows: EntityRow[] }> = [
        { type: 'run', rows: (await db.runs.where('holeId').equals(holeId).toArray()) as EntityRow[] },
        { type: 'box', rows: (await db.boxes.where('holeId').equals(holeId).toArray()) as EntityRow[] },
        { type: 'litho', rows: (await db.lithos.where('holeId').equals(holeId).toArray()) as EntityRow[] },
      ];

      for (const group of children) {
        for (const row of group.rows) {
          const itemCount = await db.reviewItems
            .where('[entityType+entityId]')
            .equals([group.type, row.id])
            .count();
          if (itemCount > 0) {
            if (!row.deletedAt) await putRow(group.type, { ...row, deletedAt: new Date().toISOString() });
          } else {
            const table = { run: db.runs, box: db.boxes, litho: db.lithos }[group.type] as Table<EntityRow, string>;
            await table.delete(row.id);
            await db.versions.where('[entityType+entityId]').equals([group.type, row.id]).delete();
          }
        }
      }

      if (softHole) {
        await db.holes.put({ ...hole, deletedAt: new Date().toISOString() });
        result = 'soft';
      } else {
        await db.holes.delete(holeId);
        await db.versions.where('[entityType+entityId]').equals(['hole', holeId]).delete();
        result = 'hard';
      }
    },
  );
  emitDataChanged();
  return result;
}

/** 版本链查询（页面查看入口用） */
export async function listVersions(type: EntityType, entityId: string): Promise<VersionRecord[]> {
  return db.versions.where('[entityType+entityId]').equals([type, entityId]).sortBy('versionNo');
}

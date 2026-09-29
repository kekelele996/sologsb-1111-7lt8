import { db } from './db';
import { uid } from './id';
import { rangesOverlap } from './recovery';
import type { CoreBox } from '../types/core-box';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { LithoLog } from '../types/litho-log';
import type { EntityKind, EntityVersion, FieldDiff, SealBatch, SealItem } from '../types/seal-review';
import { ENTITY_FIELDS, formatFieldValue, jsonEqual } from './entityMeta';

export type SealedEntity = DrillHole | DrillRun | CoreBox | LithoLog;

/** 仅约束本模块用到的实体表方法，避免 Dexie Table 泛型互不兼容 */
interface EntityTableLike {
  toArray(): Promise<unknown[]>;
  get(key: string): Promise<unknown>;
  put(entity: unknown): Promise<unknown>;
  update(key: string, changes: Record<string, unknown>): Promise<number>;
  delete(key: string): Promise<void>;
}

interface EntityTableSpec {
  kind: EntityKind;
  table: EntityTableLike;
}

const ENTITY_TABLES: EntityTableSpec[] = [
  { kind: 'hole', table: db.holes as unknown as EntityTableLike },
  { kind: 'run', table: db.runs as unknown as EntityTableLike },
  { kind: 'box', table: db.boxes as unknown as EntityTableLike },
  { kind: 'litho', table: db.lithos as unknown as EntityTableLike },
];

/** 真实 Dexie 表，仅供 db.transaction 声明用（EntityTableLike 不满足事务重载类型） */
const DEXIE_TABLES: Record<EntityKind, { toArray(): Promise<SealedEntity[]> } & Record<string, unknown>> = {
  hole: db.holes as unknown as { toArray(): Promise<SealedEntity[]> } & Record<string, unknown>,
  run: db.runs as unknown as { toArray(): Promise<SealedEntity[]> } & Record<string, unknown>,
  box: db.boxes as unknown as { toArray(): Promise<SealedEntity[]> } & Record<string, unknown>,
  litho: db.lithos as unknown as { toArray(): Promise<SealedEntity[]> } & Record<string, unknown>,
};

function dexieTable(kind: EntityKind) {
  return DEXIE_TABLES[kind] as unknown as import('dexie').Table;
}

export function tableOf(kind: EntityKind): EntityTableLike {
  return ENTITY_TABLES.find((t) => t.kind === kind)!.table;
}

export function holeIdOfEntity(kind: EntityKind, row: SealedEntity): string {
  return kind === 'hole' ? row.id : (row as DrillRun | CoreBox | LithoLog).holeId;
}

/** 记录深度区间：钻孔无深度段，封存总是包含孔本体；其余按 [from,to] 与封存段求交 */
function depthOf(kind: EntityKind, row: SealedEntity): { from: number; to: number } | null {
  if (kind === 'hole') return null;
  const r = row as DrillRun | CoreBox | LithoLog;
  return { from: r.fromDepth, to: r.toDepth };
}

/** 取某类别全部记录（含软删除，复核链需要看到删除态） */
export async function allEntities(kind: EntityKind): Promise<SealedEntity[]> {
  return (await tableOf(kind).toArray()) as SealedEntity[];
}

/** 取某类别全部存活记录（排除软删除） */
export async function liveEntities(kind: EntityKind): Promise<SealedEntity[]> {
  return (await allEntities(kind)).filter((row) => !(row as { deleted?: boolean }).deleted);
}

/** 单条记录（含软删除），找不到返回 undefined */
export async function getEntity(kind: EntityKind, id: string): Promise<SealedEntity | undefined> {
  return (await tableOf(kind).get(id)) as SealedEntity | undefined;
}

export async function listVersions(kind: EntityKind, entityId: string): Promise<EntityVersion[]> {
  return db.versions
    .where('[kind+entityId]')
    .equals([kind, entityId])
    .sortBy('versionNo') as Promise<EntityVersion[]>;
}

/** 链头版本（versionNo 最大） */
export async function headVersion(kind: EntityKind, entityId: string): Promise<EntityVersion | undefined> {
  const chain = await listVersions(kind, entityId);
  return chain[chain.length - 1];
}

/** 该记录是否曾经被封存（存在版本链） */
export async function hasVersionChain(kind: EntityKind, entityId: string): Promise<boolean> {
  const count = await db.versions.where('[kind+entityId]').equals([kind, entityId]).count();
  return count > 0;
}

/** 该钻孔是否有任意封存批次 */
export async function sealCountOfHole(holeId: string): Promise<number> {
  return db.seals.where('holeId').equals(holeId).count();
}

function snapshotOf(row: SealedEntity): SealedEntity {
  const { deleted: _deleted, ...rest } = row as SealedEntity & { deleted?: boolean };
  void _deleted;
  return { ...(rest as SealedEntity) };
}

/** 封存被拦截的原因 */
export class SealBlockedError extends Error {}

export interface CreateSealInput {
  holeId: string;
  fromDepth: number;
  toDepth: number;
  reason?: string;
  sealedBy: string;
}

interface SealTarget {
  kind: EntityKind;
  row: SealedEntity;
}

async function collectTargets(holeId: string, fromDepth: number, toDepth: number): Promise<SealTarget[]> {
  const targets: SealTarget[] = [];
  for (const { kind, table } of ENTITY_TABLES) {
    const rows = (await table.toArray()) as SealedEntity[];
    rows.forEach((row) => {
      if (holeIdOfEntity(kind, row) !== holeId) return;
      const range = depthOf(kind, row);
      if (range === null || rangesOverlap(range.from, range.to, fromDepth, toDepth)) {
        targets.push({ kind, row });
      }
    });
  }
  return targets;
}

/**
 * 按钻孔 + 深度段封存。
 * - 同孔深度重叠且尚在复核中的封存批次会直接拦截（重叠范围尚未结束复核先拦住）；
 * - 纳入与封存段相交的全部钻孔/回次/岩芯箱/岩性（端点相接不算重叠）；
 * - 尚无版本链的记录先补初始版本（旧数据或封存前新建记录），再写入封存快照版本。
 */
export async function createSeal(input: CreateSealInput): Promise<{ seal: SealBatch; itemCount: number }> {
  const { holeId, fromDepth, toDepth, sealedBy } = input;
  const hole = await db.holes.get(holeId);
  if (!hole) throw new SealBlockedError('所选钻孔不存在，无法封存');

  const reviewing = await db.seals.where('holeId').equals(holeId).filter((s) => s.status === 'reviewing').toArray();
  const conflicts = reviewing.filter((s) => rangesOverlap(s.fromDepth, s.toDepth, fromDepth, toDepth));
  if (conflicts.length) {
    const detail = conflicts.map((s) => `${s.fromDepth}~${s.toDepth}m（封存于 ${s.sealedAt.slice(0, 10)}）`).join('；');
    throw new SealBlockedError(`重叠深度段仍在复核中，请先完成或结束既有封存的复核：${detail}`);
  }

  const now = new Date().toISOString();
  const seal: SealBatch = {
    id: uid('seal'),
    holeId,
    fromDepth,
    toDepth,
    reason: input.reason?.trim() || undefined,
    sealedBy: sealedBy.trim() || '地质员',
    sealedAt: now,
    status: 'reviewing',
  };

  const targets = await collectTargets(holeId, fromDepth, toDepth);

  const additions: EntityVersion[] = [];
  const items: SealItem[] = [];

  await db.transaction('rw', [db.seals, db.versions, db.sealItems, db.holes, db.runs, db.boxes, db.lithos], async () => {
    for (const { kind, row } of targets) {
      const entityId = row.id;
      const chain = await listVersions(kind, entityId);
      let nextNo = chain.length ? chain[chain.length - 1].versionNo + 1 : 1;

      // 旧数据/封存前新建记录：先补初始版本
      if (chain.length === 0) {
        additions.push({
          id: uid('ver'),
          kind,
          entityId,
          holeId,
          versionNo: nextNo,
          source: 'init',
          actor: seal.sealedBy,
          createdAt: now,
          snapshot: snapshotOf(row),
          note: '封存时为未入链记录补建初始版本',
        });
        nextNo += 1;
      }

      // 封存快照版本（复核对照的旧版基线）
      const sealVersionNo = nextNo;
      additions.push({
        id: uid('ver'),
        kind,
        entityId,
        holeId,
        versionNo: sealVersionNo,
        source: 'seal',
        sealId: seal.id,
        actor: seal.sealedBy,
        createdAt: now,
        snapshot: snapshotOf(row),
      });

      items.push({
        id: uid('item'),
        sealId: seal.id,
        holeId,
        kind,
        entityId,
        baseVersionNo: sealVersionNo,
        verdict: 'pending',
      });
    }

    await db.seals.put(seal);
    if (additions.length) await db.versions.bulkAdd(additions);
    if (items.length) await db.sealItems.bulkAdd(items);
  });

  return { seal, itemCount: items.length };
}

interface DecideContext {
  seal: SealBatch;
  item: SealItem;
  versions: EntityVersion[];
}

async function loadDecideContext(itemId: string): Promise<DecideContext> {
  const item = await db.sealItems.get(itemId);
  if (!item) throw new Error('复核项不存在');
  const seal = await db.seals.get(item.sealId);
  if (!seal) throw new Error('封存批次不存在');
  if (seal.status === 'closed') throw new Error('该封存复核已结束，不能再给出复核结论');
  const versions = await listVersions(item.kind, item.entityId);
  return { seal, item, versions };
}

function asLive(row: SealedEntity): SealedEntity {
  const copy = { ...(row as object) } as SealedEntity & { deleted?: boolean };
  delete copy.deleted;
  return copy;
}

/**
 * 采用当前值：以当前业务记录生成新版本（采用生成新版本），结论记为已采用。
 * 当前记录已被软删除时，新版本记录删除态，链头保留删除结论。
 */
export async function adoptItem(itemId: string, reviewer: string): Promise<void> {
  const { seal, item, versions } = await loadDecideContext(itemId);
  const current = await getEntity(item.kind, item.entityId);
  if (!current) throw new Error('当前记录已不存在');

  const now = new Date().toISOString();
  const versionNo = (versions[versions.length - 1]?.versionNo ?? 0) + 1;
  const version: EntityVersion = {
    id: uid('ver'),
    kind: item.kind,
    entityId: item.entityId,
    holeId: item.holeId,
    versionNo,
    source: 'adopt',
    sealId: seal.id,
    itemId: item.id,
    actor: reviewer.trim() || seal.reviewer || '复核人',
    createdAt: now,
    snapshot: snapshotOf(current),
  };
  await db.transaction('rw', db.versions, db.sealItems, db.seals, async () => {
    await db.versions.add(version);
    await db.sealItems.update(item.id, {
      verdict: 'adopted',
      decidedAt: now,
      decidedVersionNo: versionNo,
    } as Partial<SealItem>);
    if (!seal.reviewer && reviewer.trim()) {
      await db.seals.update(seal.id, { reviewer: reviewer.trim() });
    }
  });
}

/**
 * 退回：恢复封存基线版本（把封存旧值写回业务记录，范围外内容不动），
 * 并追加一条 return 版本记录恢复动作，结论记为已退回。
 * 若当前处于软删除态，退回同时恢复记录可见性。
 */
export async function returnItem(itemId: string, reviewer: string): Promise<void> {
  const { seal, item, versions } = await loadDecideContext(itemId);
  const baseline = versions.find((v) => v.versionNo === item.baseVersionNo);
  if (!baseline) throw new Error('封存基线版本缺失，无法退回');

  const now = new Date().toISOString();
  const restored = asLive(baseline.snapshot as SealedEntity);
  const versionNo = (versions[versions.length - 1]?.versionNo ?? 0) + 1;
  const returnVersion: EntityVersion = {
    id: uid('ver'),
    kind: item.kind,
    entityId: item.entityId,
    holeId: item.holeId,
    versionNo,
    source: 'return',
    sealId: seal.id,
    itemId: item.id,
    actor: reviewer.trim() || seal.reviewer || '复核人',
    createdAt: now,
    snapshot: snapshotOf(restored),
    note: `已退回并恢复至封存基线 v${item.baseVersionNo}`,
  };

  await db.transaction('rw', [db.versions, db.sealItems, db.seals, dexieTable(item.kind)], async () => {
    await tableOf(item.kind).put(restored);
    await db.versions.add(returnVersion);
    await db.sealItems.update(item.id, {
      verdict: 'returned',
      decidedAt: now,
      decidedVersionNo: versionNo,
    } as Partial<SealItem>);
    if (!seal.reviewer && reviewer.trim()) {
      await db.seals.update(seal.id, { reviewer: reviewer.trim() });
    }
  });
}

/** 结束封存复核（已采用/已退回结论保留；未复核项保留 pending 存档） */
export async function closeSeal(sealId: string, reviewer?: string): Promise<void> {
  const seal = await db.seals.get(sealId);
  if (!seal) throw new Error('封存批次不存在');
  if (seal.status === 'closed') return;
  await db.seals.update(sealId, {
    status: 'closed',
    closedAt: new Date().toISOString(),
    reviewer: reviewer?.trim() || seal.reviewer,
  } as Partial<SealBatch>);
}

export type DeleteMode = 'soft' | 'hard';

/**
 * 清理记录：
 * - 涉及封存深度（已有版本链）的记录走软删除，保留版本链与查看入口；
 * - 从未封存的记录直接物理删除（与旧版行为一致）。
 * 返回实际使用的删除方式，供界面给出不同提示。
 */
export async function deleteEntity(kind: EntityKind, entityId: string): Promise<DeleteMode> {
  const chained = await hasVersionChain(kind, entityId);
  const table = tableOf(kind);
  if (!chained) {
    await table.delete(entityId);
    return 'hard';
  }
  const current = await getEntity(kind, entityId);
  if (!current) return 'hard';
  await table.update(entityId, { deleted: true });

  const chain = await listVersions(kind, entityId);
  const now = new Date().toISOString();
  await db.versions.add({
    id: uid('ver'),
    kind,
    entityId,
    holeId: holeIdOfEntity(kind, current),
    versionNo: (chain[chain.length - 1]?.versionNo ?? 0) + 1,
    source: 'adopt',
    actor: '清理操作',
    createdAt: now,
    snapshot: { ...(snapshotOf(current) as object), deleted: true },
    note: '记录被清理（软删除），版本链保留于封存复核台',
  });
  return 'soft';
}

/** 从归档恢复软删除记录：取链头最近的非删除快照写回，追加 restore 版本 */
export async function restoreEntity(kind: EntityKind, entityId: string, actor: string): Promise<void> {
  const chain = await listVersions(kind, entityId);
  const lastLive = [...chain].reverse().find((v) => !(v.snapshot as { deleted?: boolean }).deleted);
  if (!lastLive) throw new Error('版本链中没有可恢复的快照');
  const restored = asLive(lastLive.snapshot as SealedEntity);
  const now = new Date().toISOString();
  await db.transaction('rw', [db.versions, dexieTable(kind)], async () => {
    await tableOf(kind).put(restored);
    await db.versions.add({
      id: uid('ver'),
      kind,
      entityId,
      holeId: holeIdOfEntity(kind, restored),
      versionNo: (chain[chain.length - 1]?.versionNo ?? 0) + 1,
      source: 'restore',
      actor: actor.trim() || '复核人',
      createdAt: now,
      snapshot: snapshotOf(restored),
      note: '从封存归档恢复',
    });
  });
}

/** 全部软删除记录（清理涉及封存深度的记录的查看入口） */
export async function listArchivedEntities(): Promise<Array<{ kind: EntityKind; row: SealedEntity }>> {
  const result: Array<{ kind: EntityKind; row: SealedEntity }> = [];
  for (const { kind, table } of ENTITY_TABLES) {
    const rows = (await table.toArray()) as SealedEntity[];
    rows
      .filter((row) => (row as { deleted?: boolean }).deleted)
      .forEach((row) => result.push({ kind, row }));
  }
  return result;
}

/** 取封存基线版本快照 */
export async function baselineSnapshot(item: SealItem): Promise<SealedEntity | undefined> {
  const chain = await listVersions(item.kind, item.entityId);
  return chain.find((v) => v.versionNo === item.baseVersionNo)?.snapshot as SealedEntity | undefined;
}

/**
 * 计算复核项的逐字段差异（封存旧值 vs 当前值）。
 * 当前记录已软删除时整体视为删除差异。
 */
export function diffEntities(kind: EntityKind, oldRow: SealedEntity, current: SealedEntity): FieldDiff[] {
  if ((current as { deleted?: boolean }).deleted) {
    return [{ key: '__deleted__', label: '记录状态', oldValue: '存在', newValue: '已清理（软删除）', deleted: true }];
  }
  const diffs: FieldDiff[] = [];
  const oldRec = oldRow as unknown as Record<string, unknown>;
  const newRec = current as unknown as Record<string, unknown>;
  ENTITY_FIELDS[kind].forEach((meta) => {
    if (!jsonEqual(oldRec[meta.key], newRec[meta.key])) {
      diffs.push({ key: meta.key, label: meta.label, oldValue: formatFieldValue(meta, oldRec[meta.key]), newValue: formatFieldValue(meta, newRec[meta.key]) });
    }
  });
  return diffs;
}

/** 复核项与当前记录是否仍有差异（封存后又产生改动时给已结项重新标记） */
export function itemHasDrift(diffs: FieldDiff[]): boolean {
  return diffs.length > 0;
}

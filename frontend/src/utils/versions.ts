import dayjs from 'dayjs';
import { db } from './db';
import { uid } from './id';
import {
  FIELDS,
  type EntityRow,
  type EntityType,
  type FieldKind,
  type FieldDiff,
  type ItemDiff,
  type ReviewItem,
  type VersionAction,
  type VersionRecord,
  type VersionSnapshot,
} from '../types/seal';

/** 某类型当前活动表 */
export function liveTable(type: EntityType) {
  switch (type) {
    case 'hole':
      return db.holes;
    case 'run':
      return db.runs;
    case 'box':
      return db.boxes;
    case 'litho':
      return db.lithos;
  }
}

/** 读取记录（含已软删除的墓碑） */
export async function getLiveRow(type: EntityType, id: string): Promise<EntityRow | undefined> {
  return (await liveTable(type).get(id)) as EntityRow | undefined;
}

/** 版本链（版本号升序） */
export async function versionChain(type: EntityType, entityId: string): Promise<VersionRecord[]> {
  return db.versions.where('[entityType+entityId]').equals([type, entityId]).sortBy('versionNo');
}

/** 当前最新版本号（无版本返回 0） */
export async function latestVersionNo(type: EntityType, entityId: string): Promise<number> {
  const list = await versionChain(type, entityId);
  return list.length ? list[list.length - 1].versionNo : 0;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 追加一条版本。必须在 db.transaction 回调内调用（Dexie 会自动并入当前事务），
 * 与活动表写入同生共死，避免版本链与记录不一致。
 */
export async function appendVersion(args: {
  entityType: EntityType;
  entityId: string;
  action: VersionAction;
  snapshot: VersionSnapshot;
  sealId?: string;
  actor: string;
  note: string;
  nextNo?: number;
}): Promise<VersionRecord> {
  const versionNo = args.nextNo ?? (await latestVersionNo(args.entityType, args.entityId)) + 1;
  const record: VersionRecord = {
    id: uid('ver'),
    entityType: args.entityType,
    entityId: args.entityId,
    versionNo,
    action: args.action,
    snapshot: clone(args.snapshot),
    sealId: args.sealId,
    actor: args.actor,
    note: args.note,
    createdAt: new Date().toISOString(),
  };
  await db.versions.put(record);
  return record;
}

/**
 * 启动时幂等回填：为四类表里所有还没有版本链的记录补「初始版本」。
 * 无论数据来自 v2 升级还是种子直写，旧数据都有初始版本可查。
 */
export async function backfillInitialVersions(): Promise<number> {
  const types: EntityType[] = ['hole', 'run', 'box', 'litho'];
  let added = 0;
  await db.transaction('rw', db.versions, db.holes, db.runs, db.boxes, db.lithos, async () => {
    for (const type of types) {
      const rows = (await liveTable(type).toArray()) as EntityRow[];
      for (const row of rows) {
        const count = await db.versions.where('[entityType+entityId]').equals([type, row.id]).count();
        if (count > 0) continue;
        const record: VersionRecord = {
          id: uid('ver'),
          entityType: type,
          entityId: row.id,
          versionNo: 1,
          action: 'initial',
          snapshot: clone(row),
          actor: '系统',
          note: '旧数据补登初始版本',
          createdAt: new Date().toISOString(),
        };
        await db.versions.put(record);
        added += 1;
      }
    }
  });
  return added;
}

/** 格式化单个字段值用于对照展示 */
export function formatFieldValue(kind: FieldKind, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  switch (kind) {
    case 'date':
      return dayjs(String(value)).isValid() ? dayjs(String(value)).format('YYYY-MM-DD') : String(value);
    case 'list':
      return Array.isArray(value) ? (value.length ? value.join('、') : '无') : String(value);
    default:
      return String(value);
  }
}

/** 封存快照与当前活动值逐项对照（纯函数，切换钻孔后可直接重算，差异状态仍在） */
export function diffItem(item: ReviewItem, live: EntityRow | undefined): ItemDiff {
  // 记录已被清理（软删除墓碑或彻底不存在）
  if (!live || live.deletedAt) {
    return { kind: item.status === 'rejected' ? 'restored' : 'missing', fields: [], changedCount: 0, live };
  }

  const fields: FieldDiff[] = FIELDS[item.entityType].map((meta) => {
    const oldRaw = (item.snapshot as unknown as Record<string, unknown>)[meta.key];
    const newRaw = (live as unknown as Record<string, unknown>)[meta.key];
    const oldValue = formatFieldValue(meta.kind, oldRaw);
    const newValue = formatFieldValue(meta.kind, newRaw);
    return { key: meta.key, label: meta.label, oldValue, newValue, changed: oldValue !== newValue };
  });

  // 退回已恢复时以独立状态提示（结论是「已退回」，当前值即上一版恢复值）
  if (item.status === 'rejected') {
    return { kind: 'restored', fields, changedCount: fields.filter((f) => f.changed).length, live };
  }

  const changedCount = fields.filter((f) => f.changed).length;
  return { kind: changedCount > 0 ? 'changed' : 'same', fields, changedCount, live };
}

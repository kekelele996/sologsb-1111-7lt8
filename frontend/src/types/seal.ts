import type { DrillHole } from './drill-hole';
import type { DrillRun } from './drill-run';
import type { CoreBox } from './core-box';
import type { LithoLog } from './litho-log';

/** 参与封存与复核的四类记录 */
export type EntityType = 'hole' | 'run' | 'box' | 'litho';

export const ENTITY_TYPES: EntityType[] = ['hole', 'run', 'box', 'litho'];

export const ENTITY_TYPE_TEXT: Record<EntityType, string> = {
  hole: '钻孔',
  run: '回次',
  box: '岩芯箱',
  litho: '岩性',
};

/** 四类活动记录的联合（均带可选 deletedAt 软删除标记） */
export type EntityRow = DrillHole | DrillRun | CoreBox | LithoLog;

/** 版本快照；清理场景下数据行带 deletedAt，作为「已清理」墓碑版本保留 */
export type VersionSnapshot = EntityRow;

/** 版本来源（改动来源不再丢失） */
export type VersionAction = 'initial' | 'seal' | 'adopt' | 'reject';

export const VERSION_ACTION_TEXT: Record<VersionAction, string> = {
  initial: '初始版本',
  seal: '封存',
  adopt: '复核采用',
  reject: '复核退回',
};

/** 记录版本链上的一版 */
export interface VersionRecord {
  id: string;
  entityType: EntityType;
  entityId: string;
  /** 同一条记录内自增的版本号（1 起） */
  versionNo: number;
  action: VersionAction;
  /** 完整数据快照；清理场景为带 deletedAt 的墓碑 */
  snapshot: VersionSnapshot;
  /** 关联封存 id（初始版本为空） */
  sealId?: string;
  /** 操作人（封存人 / 复核人） */
  actor: string;
  note: string;
  createdAt: string;
}

/** 复核项状态 */
export type ReviewStatus = 'pending' | 'adopted' | 'rejected';

export const REVIEW_STATUS_TEXT: Record<ReviewStatus, string> = {
  pending: '待复核',
  adopted: '已采用',
  rejected: '已退回',
};

/** 封存快照中的单项（封存当时的记录值） */
export interface ReviewItem {
  id: string;
  sealId: string;
  entityType: EntityType;
  entityId: string;
  /** 便于展示的记录名称（孔号 / 回次号 / 箱号 / 深度段） */
  label: string;
  /** 与封存深度段的重叠范围文案；钻孔级封存为整孔 */
  scopeRange: string;
  /** 封存时该记录的版本号 */
  sealedVersionNo: number;
  /** 封存当时的完整快照（旧结论） */
  snapshot: VersionSnapshot;
  status: ReviewStatus;
  decidedBy?: string;
  decidedAt?: string;
  /** 决定后产生的新版本号（采用 / 退回） */
  finalVersionNo?: number;
}

/** 封存（按钻孔与深度段） */
export interface Seal {
  id: string;
  /** 封存单号 */
  sealNo: string;
  holeId: string;
  /** 冗余孔号，钻孔被清理后仍可展示 */
  holeNo: string;
  fromDepth: number;
  toDepth: number;
  sealedBy: string;
  /** 指定复核人 */
  reviewer: string;
  remark?: string;
  /** open=复核未结束（重叠封存要拦住）；closed=复核已结束，只留查看入口 */
  status: 'open' | 'closed';
  createdAt: string;
  reviewedAt?: string;
}

/** 字段展示类型（差异对照与格式化用） */
export type FieldKind = 'text' | 'number' | 'date' | 'depth' | 'percent' | 'list';

export interface FieldMeta {
  key: string;
  label: string;
  kind: FieldKind;
}

/** 各类型参与逐项对照的字段（备注、测斜等长字段在版本详情里仍完整保留） */
export const FIELDS: Record<EntityType, FieldMeta[]> = {
  hole: [
    { key: 'holeNo', label: '孔号', kind: 'text' },
    { key: 'coordX', label: '坐标 X', kind: 'number' },
    { key: 'coordY', label: '坐标 Y', kind: 'number' },
    { key: 'collarElevation', label: '孔口标高(m)', kind: 'number' },
    { key: 'designDepth', label: '设计孔深(m)', kind: 'depth' },
    { key: 'finalDepth', label: '终孔深度(m)', kind: 'depth' },
    { key: 'startDate', label: '开孔日期', kind: 'date' },
    { key: 'endDate', label: '终孔日期', kind: 'date' },
    { key: 'rigNo', label: '钻机号', kind: 'text' },
    { key: 'shift', label: '班组', kind: 'text' },
  ],
  run: [
    { key: 'runNo', label: '回次号', kind: 'text' },
    { key: 'fromDepth', label: '起深度(m)', kind: 'depth' },
    { key: 'toDepth', label: '止深度(m)', kind: 'depth' },
    { key: 'footage', label: '进尺(m)', kind: 'depth' },
    { key: 'coreLength', label: '岩芯长度(m)', kind: 'depth' },
    { key: 'recovery', label: '采取率(%)', kind: 'percent' },
    { key: 'waterLevel', label: '回次水位(m)', kind: 'depth' },
    { key: 'shift', label: '班次', kind: 'text' },
    { key: 'drilledAt', label: '钻进日期', kind: 'date' },
    { key: 'recorder', label: '记录人', kind: 'text' },
  ],
  box: [
    { key: 'boxNo', label: '箱号', kind: 'text' },
    { key: 'fromDepth', label: '起始深度(m)', kind: 'depth' },
    { key: 'toDepth', label: '终止深度(m)', kind: 'depth' },
    { key: 'slots', label: '格数', kind: 'number' },
    { key: 'slotLength', label: '每格长度(m)', kind: 'depth' },
    { key: 'boxedAt', label: '装箱日期', kind: 'date' },
    { key: 'shelfPos', label: '库架位', kind: 'text' },
    { key: 'damagedSlots', label: '破损格', kind: 'list' },
    { key: 'operator', label: '装箱人', kind: 'text' },
  ],
  litho: [
    { key: 'fromDepth', label: '起始深度(m)', kind: 'depth' },
    { key: 'toDepth', label: '终止深度(m)', kind: 'depth' },
    { key: 'lithology', label: '岩性', kind: 'text' },
    { key: 'color', label: '颜色', kind: 'text' },
    { key: 'alteration', label: '蚀变', kind: 'text' },
    { key: 'mineralization', label: '矿化', kind: 'text' },
    { key: 'rqd', label: 'RQD(%)', kind: 'percent' },
    { key: 'sampleNo', label: '样品号', kind: 'text' },
    { key: 'logger', label: '编录人', kind: 'text' },
  ],
};

/** 单个字段的新旧对照 */
export interface FieldDiff {
  key: string;
  label: string;
  oldValue: string;
  newValue: string;
  changed: boolean;
}

/** 一条复核项的差异结果 */
export interface ItemDiff {
  /** same=封存后未改；changed=有字段改动；missing=记录已被清理；restored=已退回恢复 */
  kind: 'same' | 'changed' | 'missing' | 'restored';
  fields: FieldDiff[];
  changedCount: number;
  live?: EntityRow;
}

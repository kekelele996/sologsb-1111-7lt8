/** 封存对象类别：钻孔 / 回次 / 岩芯箱 / 岩性 */
export type EntityKind = 'hole' | 'run' | 'box' | 'litho';

/** 版本来源：初始版本 / 封存快照 / 采用（复核通过生成新版本）/ 退回（恢复封存基线）/ 恢复（归档还原） */
export type VersionSource = 'init' | 'seal' | 'adopt' | 'return' | 'restore';

/** 复核结论：待复核 / 已采用 / 已退回 */
export type ReviewVerdict = 'pending' | 'adopted' | 'returned';

/** 封存批次：按钻孔 + 深度段封存钻孔、回次、岩芯箱与岩性 */
export interface SealBatch {
  id: string;
  /** 所属钻孔 */
  holeId: string;
  /** 封存起始深度（m） */
  fromDepth: number;
  /** 封存终止深度（m） */
  toDepth: number;
  /** 封存原因/说明 */
  reason?: string;
  /** 封存操作人 */
  sealedBy: string;
  /** 封存时间 ISO */
  sealedAt: string;
  /** 复核人 */
  reviewer?: string;
  /** 复核状态：复核中 / 已结束 */
  status: 'reviewing' | 'closed';
  /** 复核结束时间 ISO */
  closedAt?: string;
}

/** 记录版本（统一版本链表，一条链对应一条业务记录） */
export interface EntityVersion<T = unknown> {
  id: string;
  /** 记录类别 */
  kind: EntityKind;
  /** 业务记录 id */
  entityId: string;
  /** 所属钻孔（钻孔记录为自身 id），便于按孔查询 */
  holeId: string;
  /** 版本序号，从 1 开始沿版本链递增 */
  versionNo: number;
  /** 版本来源 */
  source: VersionSource;
  /** 触发该版本的封存批次 id（init 版本无） */
  sealId?: string;
  /** 触发该版本的复核项 id（adopt/return 版本） */
  itemId?: string;
  /** 操作人 */
  actor: string;
  /** 产生时间 ISO */
  createdAt: string;
  /** 版本快照（完整业务记录；deleted=true 表示删除态） */
  snapshot: T;
  /** 备注 */
  note?: string;
}

/** 封存复核项：一个封存批次内一条被封存记录的复核状态 */
export interface SealItem {
  id: string;
  /** 所属封存批次 */
  sealId: string;
  /** 所属钻孔 */
  holeId: string;
  /** 记录类别 */
  kind: EntityKind;
  /** 业务记录 id */
  entityId: string;
  /** 封存时的版本号（复核对照的旧版基线） */
  baseVersionNo: number;
  /** 复核结论 */
  verdict: ReviewVerdict;
  /** 结论产生时间 ISO */
  decidedAt?: string;
  /** 结论对应产生的新版本号（adopt/return 版本） */
  decidedVersionNo?: number;
}

/** 单字段差异（封存旧值 vs 当前值） */
export interface FieldDiff {
  key: string;
  /** 字段中文名 */
  label: string;
  oldValue: unknown;
  newValue: unknown;
  /** 是否仅展示值差异（删除态/整体差异） */
  deleted?: boolean;
}

export const ENTITY_KIND_TEXT: Record<EntityKind, string> = {
  hole: '钻孔',
  run: '回次',
  box: '岩芯箱',
  litho: '岩性',
};

export const VERSION_SOURCE_TEXT: Record<VersionSource, string> = {
  init: '初始版本',
  seal: '封存快照',
  adopt: '复核采用',
  return: '复核退回',
  restore: '归档恢复',
};

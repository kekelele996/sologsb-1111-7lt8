import Dexie, { type Table } from 'dexie';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import type { EntityKind, EntityVersion, SealBatch, SealItem } from '../types/seal-review';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbdrillcore-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class DrillCoreDB extends Dexie {
  holes!: Table<DrillHole, string>;
  runs!: Table<DrillRun, string>;
  boxes!: Table<CoreBox, string>;
  lithos!: Table<LithoLog, string>;
  seals!: Table<SealBatch, string>;
  versions!: Table<EntityVersion, string>;
  sealItems!: Table<SealItem, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      holes: 'id, holeNo, rigNo, shift, startDate',
      runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
      boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
      lithos: 'id, holeId, fromDepth, toDepth, lithology',
      meta: 'key',
    });

    // v2：岩性表增加 (holeId+fromDepth) 复合索引，按深度区间查询更快；并回填历史 rqd 缺省值。
    // 升级前请在顶栏「导出备份」导出 JSON。
    this.version(2)
      .stores({
        holes: 'id, holeNo, rigNo, shift, startDate',
        runs: 'id, runNo, holeId, fromDepth, toDepth, shift',
        boxes: 'id, boxNo, holeId, shelfPos, boxedAt',
        lithos: 'id, holeId, fromDepth, toDepth, [holeId+fromDepth], lithology',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lithos')
          .toCollection()
          .modify((row: LithoLog) => {
            if (typeof row.rqd !== 'number') {
              row.rqd = 0;
            }
          });
      });

    // v3：封存复核 + 版本链。新增 seals / versions / sealItems，
    // 并为存量钻孔、回次、岩芯箱、岩性各补一条初始版本（旧数据补初始版本）。
    this.version(3)
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
        const versionTable = tx.table<EntityVersion, string>('versions');
        const plan: Array<{ tableName: string; kind: EntityKind }> = [
          { tableName: 'holes', kind: 'hole' },
          { tableName: 'runs', kind: 'run' },
          { tableName: 'boxes', kind: 'box' },
          { tableName: 'lithos', kind: 'litho' },
        ];
        const nowIso = new Date().toISOString();
        for (const { tableName, kind } of plan) {
          const rows = await tx.table(tableName).toArray();
          const additions: EntityVersion[] = [];
          rows.forEach((row: Record<string, unknown>) => {
            const entityId = String(row.id);
            additions.push({
              id: `ver-init-${kind}-${entityId}`,
              kind,
              entityId,
              holeId: kind === 'hole' ? entityId : String(row.holeId ?? ''),
              versionNo: 1,
              source: 'init',
              actor: '系统迁移',
              createdAt: nowIso,
              snapshot: row,
              note: 'v3 升级为存量记录补建初始版本',
            });
          });
          if (additions.length) {
            await versionTable.bulkAdd(additions);
          }
        }
      });
  }
}

export const db = new DrillCoreDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

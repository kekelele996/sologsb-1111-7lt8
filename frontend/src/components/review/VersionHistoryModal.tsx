import { useEffect, useState } from 'react';
import { Modal, Spin, Table, Tag, Timeline, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { listVersions } from '../../utils/sealService';
import { VERSION_ACTION_TEXT, type EntityType, type VersionRecord } from '../../types/seal';

const { Text } = Typography;

const ACTION_COLOR: Record<string, string> = {
  initial: 'default',
  seal: 'blue',
  adopt: 'green',
  reject: 'orange',
};

interface Props {
  open: boolean;
  onClose: () => void;
  entityType: EntityType;
  entityId: string;
  /** 记录标题（孔号 / 回次号 / 箱号 / 深度段） */
  title: string;
}

/** 版本链查看入口：初始 / 封存 / 采用 / 退回 全链可查，含已清理墓碑 */
export default function VersionHistoryModal({ open, onClose, entityType, entityId, title }: Props) {
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<VersionRecord[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    listVersions(entityType, entityId)
      .then((list) => {
        if (alive) setVersions(list);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, entityType, entityId]);

  const columns: TableColumnsType<VersionRecord> = [
    {
      title: '版本',
      width: 90,
      render: (_, row) => <Text strong>v{row.versionNo}</Text>,
    },
    {
      title: '来源',
      width: 110,
      render: (_, row) => <Tag color={ACTION_COLOR[row.action]}>{VERSION_ACTION_TEXT[row.action]}</Tag>,
    },
    { title: '操作人', dataIndex: 'actor', width: 100 },
    {
      title: '时间',
      width: 160,
      render: (_, row) => dayjs(row.createdAt).format('YYYY-MM-DD HH:mm'),
    },
    { title: '说明', dataIndex: 'note', render: (v: string) => v || '—' },
    {
      title: '状态',
      width: 90,
      render: (_, row) => (row.snapshot?.deletedAt ? <Tag color="red">已清理</Tag> : <Tag>有效</Tag>),
    },
  ];

  return (
    <Modal open={open} title={`版本链 · ${title}`} onCancel={onClose} footer={null} width={820}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : versions.length === 0 ? (
        <Text type="secondary">暂无版本记录</Text>
      ) : (
        <>
          <Timeline
            items={versions.map((v) => ({
              color: v.action === 'adopt' ? 'green' : v.action === 'reject' ? 'orange' : v.action === 'seal' ? 'blue' : 'gray',
              children: (
                <Text>
                  v{v.versionNo} · {VERSION_ACTION_TEXT[v.action]} · {v.actor} ·{' '}
                  {dayjs(v.createdAt).format('YYYY-MM-DD HH:mm')}
                  {v.snapshot?.deletedAt ? <Tag color="red" style={{ marginLeft: 8 }}>已清理</Tag> : null}
                </Text>
              ),
            }))}
          />
          <Table rowKey="id" size="small" columns={columns} dataSource={versions} pagination={false} />
        </>
      )}
    </Modal>
  );
}

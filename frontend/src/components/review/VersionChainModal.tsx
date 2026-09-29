import { useEffect, useState } from 'react';
import { Empty, Modal, Spin, Tag, Timeline, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { chainOf, useReviewStore } from '../../stores/reviewStore';
import { ENTITY_KIND_TEXT, VERSION_SOURCE_TEXT, type EntityKind, type EntityVersion } from '../../types/seal-review';
import { ENTITY_FIELDS, formatFieldValue } from '../../utils/entityMeta';

const { Text } = Typography;

const SOURCE_COLOR: Record<EntityVersion['source'], string> = {
  init: 'default',
  seal: 'blue',
  adopt: 'green',
  return: 'orange',
  restore: 'cyan',
};

export interface VersionChainModalProps {
  open: boolean;
  onClose: () => void;
  kind: EntityKind;
  entityId: string;
  /** 记录标题，如回次号 / 箱号 / 深度段 */
  title?: string;
}

/** 版本链查看入口：封存后每条记录保留完整版本链（初始→封存→采用/退回/恢复） */
export default function VersionChainModal({ open, onClose, kind, entityId, title }: VersionChainModalProps) {
  const versions = useReviewStore((s) => s.versions);
  const hydrate = useReviewStore((s) => s.hydrate);
  const hydrated = useReviewStore((s) => s.hydrated);
  const [loading, setLoading] = useState(false);
  const chain = chainOf(versions, kind, entityId);

  useEffect(() => {
    if (open && !hydrated) {
      setLoading(true);
      hydrate().finally(() => setLoading(false));
    }
  }, [open, hydrated, hydrate]);

  const fields = ENTITY_FIELDS[kind];

  return (
    <Modal open={open} title={`版本链 · ${ENTITY_KIND_TEXT[kind]}${title ? ` · ${title}` : ''}`} onCancel={onClose} footer={null} width={680}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin />
        </div>
      ) : chain.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该记录尚未封存，暂无版本链" />
      ) : (
        <Timeline
          items={chain
            .slice()
            .reverse()
            .map((version) => {
              const snapshot = (version.snapshot ?? {}) as Record<string, unknown>;
              const isDeleted = Boolean(snapshot.deleted);
              return {
                dot: version.source === 'seal' ? <ClockCircleOutlined style={{ fontSize: 14 }} /> : undefined,
                color: SOURCE_COLOR[version.source] === 'default' ? 'gray' : SOURCE_COLOR[version.source],
                children: (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <Text strong>v{version.versionNo}</Text>
                      <Tag color={SOURCE_COLOR[version.source]}>{VERSION_SOURCE_TEXT[version.source]}</Tag>
                      {isDeleted ? <Tag color="red">记录已清理（软删除）</Tag> : null}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(version.createdAt).format('YYYY-MM-DD HH:mm')} · {version.actor}
                      </Text>
                    </div>
                    {version.note ? <div style={{ fontSize: 12, color: '#8a99a5', marginTop: 2 }}>{version.note}</div> : null}
                    <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px' }}>
                      {fields.map((meta) => (
                        <div key={meta.key} style={{ fontSize: 12, lineHeight: 1.8 }}>
                          <Text type="secondary">{meta.label}：</Text>
                          <span>{formatFieldValue(meta, snapshot[meta.key])}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ),
              };
            })}
        />
      )}
    </Modal>
  );
}

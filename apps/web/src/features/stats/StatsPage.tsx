import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Empty,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_KIND_LABELS,
  MAX_REMINDER_LEVEL,
  REMINDER_LEVEL_LABELS,
  RESPONSIBLE_SOURCE_LABELS,
  ROLE_LABELS,
  VAGUE_CATEGORY_LABELS,
  VAGUE_STATUS_LABELS,
  type MemberStatsDto,
  type ReminderLevel,
  type StaleItemDto,
} from '@froa/shared';
import { statsApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAuthStore } from '../../store/auth';

const STALE_DAY_OPTIONS = [
  { value: 3, label: '超过 3 天' },
  { value: 7, label: '超过 7 天' },
  { value: 14, label: '超过 14 天' },
];

/** 贡献构成：把各项明细拼成一句话，放进悬浮提示里 */
function contributionBreakdown(member: MemberStatsDto): string {
  const parts = CONTRIBUTION_KINDS.filter((kind) => member.contributions[kind] > 0).map(
    (kind) => `${CONTRIBUTION_KIND_LABELS[kind]} ${member.contributions[kind]}`,
  );
  return parts.length ? parts.join('，') : '还没有任何贡献记录';
}

export function StatsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const me = useAuthStore((s) => s.user);
  const [staleDays, setStaleDays] = useState(3);

  const stats = useQuery({
    queryKey: ['member-stats', workspaceId, staleDays],
    queryFn: () => statsApi.memberStats(workspaceId!, staleDays),
    enabled: Boolean(workspaceId),
  });
  const stale = useQuery({
    queryKey: ['stale-items', workspaceId, staleDays],
    queryFn: () => statsApi.staleItems(workspaceId!, staleDays),
    enabled: Boolean(workspaceId),
  });

  const remindMutation = useMutation({
    mutationFn: (itemId: string) => statsApi.remind(itemId),
    onSuccess: (result) => {
      message.success(`已发出第 ${result.level} 级提醒（${REMINDER_LEVEL_LABELS[result.level]}）`);
      void queryClient.invalidateQueries({ queryKey: ['stale-items', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['member-stats', workspaceId] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (stats.isLoading || stale.isLoading) return <Spin size="large" />;

  const members = stats.data?.members ?? [];
  const staleItems = stale.data?.items ?? [];

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>贡献与积压</h1>
          <div className="froa-hint">
            谁出了多少力、谁那边压着事，一眼看清。滞留条目总会点到一个负责人的名，提醒不到人就逐级升级。
          </div>
        </div>
        <Segmented
          value={staleDays}
          onChange={(value) => setStaleDays(value as number)}
          options={STALE_DAY_OPTIONS}
        />
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">成员贡献与积压</h3>
        <Table<MemberStatsDto>
          rowKey="userId"
          dataSource={members}
          pagination={false}
          columns={[
            {
              title: '成员',
              dataIndex: 'displayName',
              render: (_, record) => (
                <span>
                  {record.displayName}
                  {record.userId === me?.id ? '（我）' : ''}
                </span>
              ),
            },
            {
              title: '角色',
              dataIndex: 'role',
              render: (role: MemberStatsDto['role']) => <Tag>{ROLE_LABELS[role]}</Tag>,
            },
            {
              title: '贡献量',
              dataIndex: 'contributionTotal',
              sorter: (a, b) => a.contributionTotal - b.contributionTotal,
              defaultSortOrder: 'descend',
              render: (_, record) => (
                <Tooltip title={contributionBreakdown(record)}>
                  <strong>{record.contributionTotal}</strong>
                </Tooltip>
              ),
            },
            {
              title: '待收口条目',
              render: (_, record) => record.backlog.openItems,
            },
            {
              title: `滞留（>${staleDays} 天）`,
              render: (_, record) =>
                record.backlog.staleItems > 0 ? (
                  <Tag color="red">{record.backlog.staleItems} 条</Tag>
                ) : (
                  <Tag color="green">无</Tag>
                ),
            },
            {
              title: '最久滞留',
              render: (_, record) =>
                record.backlog.oldestStaleDays > 0 ? `${record.backlog.oldestStaleDays} 天` : '—',
            },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
          积压按负责人口径统计：被指派人 → 食谱创建者 → 空间所有者。贡献明细悬浮在数字上可看。
        </Typography.Paragraph>
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">滞留条目（{staleItems.length}）</h3>
        {staleItems.length === 0 ? (
          <Empty description={`没有超过 ${staleDays} 天没人处理的条目，继续保持`} />
        ) : (
          <Table<StaleItemDto>
            rowKey="itemId"
            dataSource={staleItems}
            pagination={false}
            columns={[
              {
                title: '原话',
                dataIndex: 'rawPhrase',
                render: (value: string, record) => (
                  <Space direction="vertical" size={2}>
                    <Link to={`/w/${workspaceId}/recipes/${record.recipeId}/inbox`}>
                      「{value}」
                    </Link>
                    <Typography.Text type="secondary" style={{ fontSize: '0.85rem' }}>
                      {record.recipeTitle}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                title: '分类',
                dataIndex: 'category',
                render: (value: StaleItemDto['category']) => VAGUE_CATEGORY_LABELS[value],
              },
              {
                title: '状态',
                dataIndex: 'status',
                render: (value: StaleItemDto['status']) => VAGUE_STATUS_LABELS[value],
              },
              {
                title: '滞留',
                dataIndex: 'staleDays',
                sorter: (a, b) => a.staleDays - b.staleDays,
                defaultSortOrder: 'descend',
                render: (value: number) => <Tag color="red">{value} 天</Tag>,
              },
              {
                title: '负责人',
                render: (_, record) => (
                  <Space size={4}>
                    <span>{record.responsible.displayName}</span>
                    <Tag>{RESPONSIBLE_SOURCE_LABELS[record.responsible.source]}</Tag>
                  </Space>
                ),
              },
              {
                title: '已提醒',
                dataIndex: 'reminderLevel',
                render: (level: number) =>
                  level > 0 ? (
                    <Tag color={level >= MAX_REMINDER_LEVEL ? 'red' : 'gold'}>
                      {REMINDER_LEVEL_LABELS[level as ReminderLevel]}
                    </Tag>
                  ) : (
                    '—'
                  ),
              },
              {
                title: '',
                render: (_, record) =>
                  record.reminderLevel >= MAX_REMINDER_LEVEL ? (
                    <Typography.Text type="secondary">已到最高级</Typography.Text>
                  ) : (
                    <Button
                      size="small"
                      icon={<BellOutlined />}
                      loading={remindMutation.isPending && remindMutation.variables === record.itemId}
                      onClick={() => remindMutation.mutate(record.itemId)}
                    >
                      {REMINDER_LEVEL_LABELS[(record.reminderLevel + 1) as ReminderLevel]}
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Empty,
  Popconfirm,
  Select,
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
  NUDGE_LEVEL_LABELS,
  ROLE_LABELS,
  VAGUE_CATEGORY_LABELS,
  VAGUE_STATUS_LABELS,
  type MemberContributionDto,
  type StaleItemDto,
} from '@froa/shared';
import { statsApi, vagueItemApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { useAuthStore } from '../../store/auth';

const STALE_DAY_OPTIONS = [
  { value: 1, label: '超过 1 天' },
  { value: 3, label: '超过 3 天' },
  { value: 7, label: '超过 7 天' },
  { value: 14, label: '超过 14 天' },
];

/**
 * 成员统计：每个人贡献了多少、积压了多少；
 * 滞留条目标出负责人，并支持逐级提醒（负责人 → 整理者 → 全家）。
 */
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

  const nudgeMutation = useMutation({
    mutationFn: (itemId: string) => vagueItemApi.nudge(itemId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['member-stats', workspaceId] });
      message.success(
        result.notifiedUserIds.length
          ? `已${NUDGE_LEVEL_LABELS[result.level]}（${result.notifiedUserIds.length} 人）`
          : '没有可提醒的家人（其他成员可能已不在空间里）',
      );
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (stats.isLoading) {
    return (
      <div className="froa-center-page">
        <Spin size="large" />
      </div>
    );
  }

  const data = stats.data;
  const members = data?.members ?? [];
  const staleItems = data?.staleItems ?? [];

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>成员统计</h1>
          <div className="froa-hint">
            看看谁在扛活、哪里卡住了。滞留条目可以逐级提醒：先提醒负责人，再提醒整理者，最后提醒全家。
          </div>
        </div>
        <Space>
          <span className="froa-hint">滞留阈值</span>
          <Select
            value={staleDays}
            style={{ width: 130 }}
            options={STALE_DAY_OPTIONS}
            onChange={setStaleDays}
            aria-label="滞留阈值"
          />
        </Space>
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">贡献量与积压</h3>
        <Table<MemberContributionDto>
          rowKey="userId"
          dataSource={members}
          pagination={false}
          columns={[
            {
              title: '成员',
              dataIndex: 'displayName',
              render: (_, record) => (
                <Space size="small" wrap>
                  <span>
                    {record.displayName}
                    {record.userId === me?.id ? '（我）' : ''}
                  </span>
                  <Tag>{ROLE_LABELS[record.role]}</Tag>
                </Space>
              ),
            },
            {
              title: '贡献量',
              key: 'contributions',
              render: (_, record) => {
                const c = record.contributions;
                return (
                  <Tooltip
                    title={`录音 ${c.audioUploaded} ｜ 提出条目 ${c.itemsCreated} ｜ 答复 ${c.answersGiven} ｜ 规格化 ${c.itemsResolved} ｜ 复做 ${c.verificationsDone} ｜ 评论 ${c.commentsPosted}`}
                  >
                    <span>
                      录音 <strong>{c.audioUploaded}</strong> · 条目 <strong>{c.itemsCreated}</strong> · 答复{' '}
                      <strong>{c.answersGiven}</strong> · 规格化 <strong>{c.itemsResolved}</strong> · 复做{' '}
                      <strong>{c.verificationsDone}</strong> · 评论 <strong>{c.commentsPosted}</strong>
                      <Typography.Text type="secondary">（合计 {c.total}）</Typography.Text>
                    </span>
                  </Tooltip>
                );
              },
            },
            {
              title: '积压（待 TA 答复）',
              key: 'backlog',
              width: 220,
              render: (_, record) =>
                record.backlog.toAnswer === 0 ? (
                  <Typography.Text type="secondary">无</Typography.Text>
                ) : (
                  <Space size="small">
                    <strong>{record.backlog.toAnswer} 条</strong>
                    {record.backlog.staleToAnswer > 0 && (
                      <Tag color="red">其中 {record.backlog.staleToAnswer} 条滞留</Tag>
                    )}
                  </Space>
                ),
            },
          ]}
        />
      </div>

      <div className="froa-card">
        <h3 className="froa-card-title">滞留条目（{staleItems.length}）</h3>
        {staleItems.length === 0 ? (
          <Empty description={`没有超过 ${staleDays} 天没人处理的条目，运转良好`} />
        ) : (
          <Table<StaleItemDto>
            rowKey="id"
            dataSource={staleItems}
            pagination={false}
            columns={[
              {
                title: '条目',
                dataIndex: 'rawPhrase',
                render: (_, record) => (
                  <Space direction="vertical" size={2}>
                    <span>
                      「{record.rawPhrase}」
                      <Typography.Text type="secondary">（{record.recipeTitle}）</Typography.Text>
                    </span>
                    <Space size="small">
                      <Tag>{VAGUE_CATEGORY_LABELS[record.category]}</Tag>
                      <Tag color="gold">{VAGUE_STATUS_LABELS[record.status]}</Tag>
                    </Space>
                  </Space>
                ),
              },
              {
                title: '滞留',
                dataIndex: 'staleDays',
                width: 90,
                render: (days: number) => <Tag color="red">{days} 天</Tag>,
              },
              {
                title: '负责人',
                key: 'owner',
                width: 160,
                render: (_, record) =>
                  record.owner ? (
                    <span>
                      {record.owner.displayName}
                      <Typography.Text type="secondary">
                        （{record.ownerKind === 'assignee' ? '被指派人' : '提出人'}）
                      </Typography.Text>
                    </span>
                  ) : (
                    <Typography.Text type="secondary">未指定</Typography.Text>
                  ),
              },
              {
                title: '已提醒',
                key: 'nudge',
                width: 130,
                render: (_, record) =>
                  record.nudgeCount === 0 ? (
                    <Typography.Text type="secondary">未提醒</Typography.Text>
                  ) : (
                    <Tooltip title={`上次提醒：${record.lastNudgedAt?.slice(0, 16).replace('T', ' ')}`}>
                      <span>{record.nudgeCount} 次</span>
                    </Tooltip>
                  ),
              },
              {
                title: '',
                key: 'actions',
                width: 240,
                render: (_, record) => (
                  <Space size="small" wrap>
                    <Link to={`/w/${workspaceId}/recipes/${record.recipeId}/inbox`}>去处理</Link>
                    {record.canNudge ? (
                      <Popconfirm
                        title={NUDGE_LEVEL_LABELS[record.nextNudgeLevel]}
                        description={`将向${record.nextNudgeLevel >= 3 ? '全体家庭成员' : '相关家人'}发送提醒通知，确定吗？`}
                        okText="发送提醒"
                        cancelText="取消"
                        onConfirm={() => nudgeMutation.mutate(record.id)}
                      >
                        <Button
                          size="small"
                          icon={<BellOutlined />}
                          loading={nudgeMutation.isPending && nudgeMutation.variables === record.id}
                        >
                          {NUDGE_LEVEL_LABELS[record.nextNudgeLevel]}
                        </Button>
                      </Popconfirm>
                    ) : (
                      <Tooltip title={`同一条目 ${data?.nudgeCooldownHours ?? 20} 小时内只能提醒一次`}>
                        <Button size="small" disabled>
                          已提醒，冷却中
                        </Button>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}

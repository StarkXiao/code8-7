import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Badge, Button, Empty, List, Space, Spin, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationType } from '@froa/shared';
import { notificationApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';

const TYPE_LABEL: Record<NotificationType, string> = {
  mentioned: '有人提到了你',
  assigned: '有人问你问题',
  answered: '你的追问有人回答了',
  published: '版本动态',
  verification_requested: '需要你做复做验证',
  verification_passed: '复做成功',
  verification_failed: '复做出现问题',
  reminder: '滞留条目提醒',
};

const TYPE_COLOR: Record<NotificationType, string> = {
  mentioned: 'blue',
  assigned: 'gold',
  answered: 'cyan',
  published: 'green',
  verification_requested: 'purple',
  verification_passed: 'green',
  verification_failed: 'red',
  reminder: 'orange',
};

export function NotificationsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationApi.list(),
  });

  const readMutation = useMutation({
    mutationFn: (input: { ids?: string[]; all?: boolean }) => notificationApi.markRead(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  if (notifications.isLoading) return <Spin size="large" />;

  const list = notifications.data ?? [];
  const unread = list.filter((item) => !item.readAt).length;

  // 点通知直接跳到该处理的地方 —— 通知不能只是"知道"，要能"去做"
  const open = (payload: Record<string, unknown> | null) => {
    const recipeId = payload?.recipeId as string | undefined;
    const itemId = (payload?.itemId ?? payload?.targetId) as string | undefined;
    if (!recipeId || !workspaceId) return;

    if (itemId) {
      navigate(`/w/${workspaceId}/recipes/${recipeId}/inbox`);
      return;
    }
    navigate(`/w/${workspaceId}/recipes/${recipeId}`);
  };

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>通知</h1>
          <div className="froa-hint">未读 {unread} 条。点一条会直接跳到该处理的地方。</div>
        </div>
        <Button
          disabled={!unread}
          loading={readMutation.isPending}
          onClick={() => readMutation.mutate({ all: true })}
        >
          全部标为已读
        </Button>
      </div>

      {list.length === 0 ? (
        <Empty description="还没有通知" />
      ) : (
        <List
          dataSource={list}
          renderItem={(item) => {
            const payload = item.payload ?? {};
            const type = item.type as NotificationType;
            return (
              <List.Item
                actions={[
                  <Button
                    key="open"
                    type="link"
                    onClick={() => {
                      if (!item.readAt) readMutation.mutate({ ids: [item.id] });
                      open(payload);
                    }}
                  >
                    去处理
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<Badge dot={!item.readAt} />}
                  title={
                    <Space wrap>
                      <Tag color={TYPE_COLOR[type]}>{TYPE_LABEL[type] ?? item.type}</Tag>
                      <span>{String(payload.message ?? '')}</span>
                    </Space>
                  }
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: '0.85rem' }}>
                      {item.createdAt.slice(0, 16).replace('T', ' ')}
                    </Typography.Text>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );
}

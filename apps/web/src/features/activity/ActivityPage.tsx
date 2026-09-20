import { useParams } from 'react-router-dom';
import { Empty, List, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { workspaceApi } from '../../api/endpoints';

const ACTION_LABEL: Record<string, string> = {
  'recipe.create': '创建了食谱',
  'recipe.update': '修改了食谱信息',
  'recipe.archive': '归档了食谱',
  'version.fork': '派生了一个新草稿版本',
  'version.update': '修改了版本信息',
  'version.submit': '提交了评审',
  'version.reopen': '把版本退回草稿',
  'version.publish': '发布了版本',
  'step.create': '新增了步骤',
  'step.update': '修改了步骤',
  'step.delete': '删除了步骤',
  'ingredient.create': '新增了用量',
  'ingredient.update': '修改了用量',
  'ingredient.delete': '删除了用量',
  'vague_item.create': '新增了一条待澄清条目',
  'vague_item.update': '修改了条目信息',
  'vague_item.ask': '发出了追问',
  'vague_item.answer': '记录了答复',
  'vague_item.resolve': '整理出了可复做结论',
  'vague_item.confirm': '重新确认了结论',
  'vague_item.mark_unresolvable': '标记为口语留白',
  'vague_item.reopen': '重新打开了条目',
  'vague_item.nudge': '提醒了滞留条目的负责人',
  'verification.create': '提交了复做验证',
  'audio.upload': '上传了语音',
  'audio.softDelete': '删除了语音（软删除）',
  'audio.clip.create': '框选了一段音频片段',
  'workspace.join': '加入了家庭空间',
  'workspace.member.role.update': '调整了成员角色',
  'workspace.member.remove': '移除了成员',
  'comment.create': '发表了评论',
};

// 操作日志只追加不修改：改规格、删音频、发布版本都能追溯到人。
export function ActivityPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();

  const logs = useQuery({
    queryKey: ['activity', workspaceId],
    queryFn: () => workspaceApi.activity(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  if (logs.isLoading) return <Spin size="large" />;

  const list = logs.data ?? [];

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>操作日志</h1>
          <div className="froa-hint">
            谁在什么时候改了什么，全部记在这里，且不可修改。出问题时可以从这里倒推。
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <Empty description="还没有操作记录" />
      ) : (
        <List
          dataSource={list}
          renderItem={(log) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <span>
                    <strong>{log.actor?.displayName ?? '某人'}</strong>{' '}
                    {ACTION_LABEL[log.action] ?? log.action}
                  </span>
                }
                description={
                  <Typography.Text type="secondary" style={{ fontSize: '0.85rem' }}>
                    {log.createdAt.slice(0, 19).replace('T', ' ')} ｜ {log.entityType}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

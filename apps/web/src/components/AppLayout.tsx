import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Dropdown, Select, Space } from 'antd';
import {
  BellOutlined,
  HistoryOutlined,
  LogoutOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { notificationApi } from '../api/endpoints';
import { useAuthStore } from '../store/auth';
import { useUiStore, type FontScale } from '../store/ui';

const FONT_OPTIONS: { value: FontScale; label: string }[] = [
  { value: 'normal', label: '标准字号' },
  { value: 'large', label: '大字号' },
  { value: 'xlarge', label: '特大字号' },
];

/** 家庭空间内的统一外壳：导航 + 字号切换 + 未读通知 */
export function AppLayout() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const fontScale = useUiStore((s) => s.fontScale);
  const setFontScale = useUiStore((s) => s.setFontScale);

  const notifications = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => notificationApi.list({ unread: true }),
    enabled: Boolean(user),
    refetchInterval: 60_000,
  });

  const unread = notifications.data?.length ?? 0;
  const base = workspaceId ? `/w/${workspaceId}` : '/';

  return (
    <div className="froa-shell">
      <header className="froa-header">
        <Link to="/" className="froa-brand">
          家庭食谱口述整理器
        </Link>

        {workspaceId && (
          <nav className="froa-nav">
            <NavLink to={base} end>
              食谱
            </NavLink>
            <NavLink to={`${base}/members`}>成员</NavLink>
            <NavLink to={`${base}/stats`}>贡献与积压</NavLink>
            <NavLink to={`${base}/notifications`}>通知</NavLink>
            <NavLink to={`${base}/activity`}>操作日志</NavLink>
          </nav>
        )}

        <Space size="small" wrap>
          <Select
            size="small"
            value={fontScale}
            onChange={setFontScale}
            options={FONT_OPTIONS}
            style={{ width: 118 }}
            aria-label="字号"
          />

          <Badge count={unread} size="small" offset={[-2, 2]}>
            <Button
              type="text"
              icon={<BellOutlined />}
              onClick={() => navigate(workspaceId ? `${base}/notifications` : '/')}
              aria-label="通知"
            />
          </Badge>

          <Dropdown
            menu={{
              items: [
                {
                  key: 'font',
                  label: `当前字号：${FONT_OPTIONS.find((o) => o.value === fontScale)?.label}`,
                  disabled: true,
                },
                { type: 'divider' },
                {
                  key: 'team',
                  icon: <TeamOutlined />,
                  label: '成员与权限',
                  onClick: () => workspaceId && navigate(`${base}/members`),
                  disabled: !workspaceId,
                },
                {
                  key: 'activity',
                  icon: <HistoryOutlined />,
                  label: '操作日志',
                  onClick: () => workspaceId && navigate(`${base}/activity`),
                  disabled: !workspaceId,
                },
                { type: 'divider' },
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: '退出登录',
                  onClick: () => {
                    logout();
                    navigate('/login');
                  },
                },
              ],
            }}
          >
            <Button type="text" icon={<UserOutlined />}>
              {user?.displayName ?? '未登录'}
            </Button>
          </Dropdown>
        </Space>
      </header>

      <main className="froa-main">
        <Outlet />
      </main>
    </div>
  );
}

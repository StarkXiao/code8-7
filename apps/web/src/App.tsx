import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { AppLayout } from './components/AppLayout';
import { GlobalPlayer } from './components/GlobalPlayer';
import { useRealtime } from './hooks/useRealtime';
import { useAuthStore } from './store/auth';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { JoinPage } from './features/workspace/JoinPage';
import { WorkspaceListPage } from './features/workspace/WorkspaceListPage';
import { WorkspaceHomePage } from './features/workspace/WorkspaceHomePage';
import { MembersPage } from './features/workspace/MembersPage';
import { StatsPage } from './features/stats/StatsPage';
import { RecipeDetailPage } from './features/recipe/RecipeDetailPage';
import { RecorderPage } from './features/recorder/RecorderPage';
import { InboxPage } from './features/vagueItems/InboxPage';
import { EditorPage } from './features/editor/EditorPage';
import { VersionsPage } from './features/versions/VersionsPage';
import { DiffPage } from './features/versions/DiffPage';
import { VerifyPage } from './features/verification/VerifyPage';
import { NotificationsPage } from './features/notification/NotificationsPage';
import { ActivityPage } from './features/activity/ActivityPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const location = useLocation();

  if (loading) {
    return (
      <div className="froa-center-page">
        {/* 独立使用时 antd 的 tip 不生效，必须配合 fullscreen 或嵌套用法 */}
        <Spin size="large" fullscreen tip="正在恢复登录状态…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 登录后建立实时协作通道
  useRealtime();

  return (
    <>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/register" element={user ? <Navigate to="/" replace /> : <RegisterPage />} />

        <Route
          path="/join/:inviteCode"
          element={
            <RequireAuth>
              <JoinPage />
            </RequireAuth>
          }
        />

        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<WorkspaceListPage />} />
        </Route>

        <Route
          path="/w/:workspaceId"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<WorkspaceHomePage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="stats" element={<StatsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="recipes/:recipeId" element={<RecipeDetailPage />} />
          <Route path="recipes/:recipeId/record" element={<RecorderPage />} />
          <Route path="recipes/:recipeId/inbox" element={<InboxPage />} />
          <Route path="recipes/:recipeId/edit" element={<EditorPage />} />
          <Route path="recipes/:recipeId/verify" element={<VerifyPage />} />
          <Route path="recipes/:recipeId/versions" element={<VersionsPage />} />
          <Route
            path="recipes/:recipeId/versions/:baseId/diff/:targetId"
            element={<DiffPage />}
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <GlobalPlayer />
    </>
  );
}

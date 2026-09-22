import { Spin } from 'antd';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthContext';
import { ProjectLayout } from './layout/ProjectLayout';
import { AuthPage } from './pages/AuthPage';
import { AcceptInvitationPage } from './pages/AcceptInvitationPage';
import { CustomEventsPage } from './pages/CustomEventsPage';
import { OverviewPage } from './pages/OverviewPage';
import { PerformancePage } from './pages/PerformancePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RawEventsPage } from './pages/RawEventsPage';
import { RoutesPage } from './pages/RoutesPage';
import { SettingsPage } from './pages/SettingsPage';
import { ServiceStatusPage } from './pages/ServiceStatusPage';

function Protected({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) return <div className="centered"><Spin size="large" /></div>;
  if (!auth.user) return <Navigate to="/login" state={{ from: `${location.pathname}${location.search}` }} replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/verify-email" element={<AuthPage mode="verify" />} />
      <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
      <Route path="/reset-password" element={<AuthPage mode="reset" />} />
      <Route
        path="/projects"
        element={<Protected><ProjectsPage /></Protected>}
      />
      <Route
        path="/accept-invitation"
        element={<Protected><AcceptInvitationPage /></Protected>}
      />
      <Route
        path="/projects/:projectId"
        element={<Protected><ProjectLayout /></Protected>}
      >
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="routes" element={<RoutesPage />} />
        <Route path="events" element={<CustomEventsPage />} />
        <Route path="raw-events" element={<RawEventsPage />} />
        <Route path="service-status" element={<ServiceStatusPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

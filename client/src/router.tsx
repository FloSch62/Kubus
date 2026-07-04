import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from './layout/AppShell.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { ResourceListPage } from './pages/ResourceListPage.js';
import { HelmPage } from './pages/HelmPage.js';
import { HelmReleaseDetailPage } from './pages/HelmReleaseDetail.js';
import { PortForwardsPage } from './pages/PortForwardsPage.js';
import { DiffPage } from './pages/DiffPage.js';
import { TopologyPage } from './pages/TopologyPage.js';
import { EventsPage } from './pages/EventsPage.js';
import { AuditPage } from './pages/AuditPage.js';

export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="/r/:group/:version/:plural" element={<ResourceListPage />} />
        <Route path="/helm" element={<HelmPage />} />
        <Route path="/helm/:ctx/:ns/:name" element={<HelmReleaseDetailPage />} />
        <Route path="/forwards" element={<PortForwardsPage />} />
        <Route path="/diff" element={<DiffPage />} />
        <Route path="/topology" element={<TopologyPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

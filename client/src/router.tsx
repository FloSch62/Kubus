import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { AppShell } from './layout/AppShell.js';
import { usePaneActive } from './layout/pane-context.js';

const OverviewPage = lazy(() => import('./pages/OverviewPage.js').then((m) => ({ default: m.OverviewPage })));
const ResourceListPage = lazy(() => import('./pages/ResourceListPage.js').then((m) => ({ default: m.ResourceListPage })));
const HelmPage = lazy(() => import('./pages/HelmPage.js').then((m) => ({ default: m.HelmPage })));
const HelmReleaseDetailPage = lazy(() => import('./pages/HelmReleaseDetail.js').then((m) => ({ default: m.HelmReleaseDetailPage })));
const PortForwardsPage = lazy(() => import('./pages/PortForwardsPage.js').then((m) => ({ default: m.PortForwardsPage })));
const DiffPage = lazy(() => import('./pages/DiffPage.js').then((m) => ({ default: m.DiffPage })));
const TopologyPage = lazy(() => import('./pages/TopologyPage.js').then((m) => ({ default: m.TopologyPage })));
const MetricsPage = lazy(() => import('./pages/MetricsPage.js').then((m) => ({ default: m.MetricsPage })));
const EventsPage = lazy(() => import('./pages/EventsPage.js').then((m) => ({ default: m.EventsPage })));
const AuditPage = lazy(() => import('./pages/AuditPage.js').then((m) => ({ default: m.AuditPage })));

const pageLoading = (
  <Box sx={{ display: 'flex', justifyContent: 'center', pt: 8 }}>
    <CircularProgress size={24} />
  </Box>
);

// Per-route boundary so the shell stays mounted while a page chunk loads.
const page = (element: ReactNode) => <Suspense fallback={pageLoading}>{element}</Suspense>;

// Only the active pane may redirect: a hidden pane with a stale/unknown path
// (e.g. a persisted tab from an older version) must not hijack navigation.
function PaneCatchAll() {
  return usePaneActive() ? <Navigate to="/" replace /> : null;
}

/**
 * The page routes for one tab pane. Matching follows the pane's location
 * context (frozen for hidden tabs, live for the active one).
 */
export function PageRoutes() {
  return (
    <Routes>
      <Route path="/" element={page(<OverviewPage />)} />
      <Route path="/r/:group/:version/:plural" element={page(<ResourceListPage />)} />
      <Route path="/helm" element={page(<HelmPage />)} />
      <Route path="/helm/:ctx/:ns/:name" element={page(<HelmReleaseDetailPage />)} />
      <Route path="/forwards" element={page(<PortForwardsPage />)} />
      <Route path="/diff" element={page(<DiffPage />)} />
      <Route path="/topology" element={page(<TopologyPage />)} />
      <Route path="/metrics" element={page(<MetricsPage />)} />
      <Route path="/events" element={page(<EventsPage />)} />
      <Route path="/audit" element={page(<AuditPage />)} />
      <Route path="*" element={<PaneCatchAll />} />
    </Routes>
  );
}

export function AppRouter() {
  return <AppShell />;
}

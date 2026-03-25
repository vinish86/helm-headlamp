import { registerDetailsViewSection, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { ReleaseDetail, ReleaseDetailContent } from './components/ReleaseDetail';
import { ReleaseList } from './components/ReleaseList';

// Ship's wheel icon (Iconify object format — same as crossplane plugin)
const helmIcon = {
  body: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="2" y1="12" x2="5" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4.93" y1="4.93" x2="7.05" y2="7.05" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16.95" y1="16.95" x2="19.07" y2="19.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="4.93" y1="19.07" x2="7.05" y2="16.95" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16.95" y1="7.05" x2="19.07" y2="4.93" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  width: 24,
  height: 24,
};

// ── Sidebar ──────────────────────────────────────────────────────────────────

registerSidebarEntry({
  parent: '',
  name: 'helm',
  label: 'Helm',
  icon: helmIcon,
  url: '/helm/releases',
});

registerSidebarEntry({
  parent: 'helm',
  name: 'helm-releases',
  label: 'Releases',
  url: '/helm/releases',
});

// ── Routes ───────────────────────────────────────────────────────────────────

registerRoute({
  path: '/helm/releases',
  sidebar: 'helm-releases',
  component: () => <ReleaseList />,
  exact: true,
  name: 'helm-releases',
});

registerRoute({
  path: '/helm/releases/:namespace/:name',
  sidebar: 'helm-releases',
  component: () => <ReleaseDetail />,
  exact: true,
  name: 'helm-release-detail',
});

// ── Details view section injected into the native Secret detail view ──────────
// Helm releases are stored as Kubernetes Secrets (owner=helm label).
// This section renders the full Helm release UI inside the native Secret detail,
// giving drawer mode and multi-panel support for free.

registerDetailsViewSection(({ resource }: { resource: any }) => {
  if (resource?.kind !== 'Secret') return null;

  const labels = resource?.jsonData?.metadata?.labels ?? {};
  if (labels?.owner !== 'helm') return null;

  // Only show on the latest revision secret (highest version label)
  // to avoid showing the section on historical revision secrets.
  // The name column in ReleaseList always links to the latest revision secret.
  const namespace = resource?.jsonData?.metadata?.namespace ?? '';
  const name = labels?.name ?? '';
  if (!namespace || !name) return null;

  return <ReleaseDetailContent namespace={namespace} name={name} />;
});

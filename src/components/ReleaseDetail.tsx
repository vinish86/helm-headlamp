import {
  ConfirmButton,
  Loader,
  SectionBox,
  SimpleTable,
  Tabs,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import React, { useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import {
  HelmRelease,
  HelmRevision,
  ManifestResource,
  parseManifest,
  toYaml,
  useHelmRelease,
  useRevisions,
} from '../helm';
import { helmRollback, helmUninstall } from '../helmOps';
import { RevisionDiffDialog } from './RevisionDiff';

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(s: string): 'success' | 'error' | 'warning' | 'default' {
  if (s === 'deployed') return 'success';
  if (s === 'failed') return 'error';
  if (s.startsWith('pending') || s === 'uninstalling') return 'warning';
  return 'default';
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function CodeBlock({ children }: { children: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, fontFamily: 'monospace', fontSize: '0.82rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 500, overflow: 'auto', bgcolor: 'background.default' }}>
      {children}
    </Paper>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', gap: 2, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160, fontWeight: 600, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div">{value ?? '—'}</Typography>
    </Box>
  );
}

interface OpState { running: boolean; label: string; error?: string; success?: string; }

// ── Tab components ────────────────────────────────────────────────────────────

function OverviewTab({ release }: { release: HelmRelease }) {
  const chart = release.chart?.metadata;
  return (
    <>
      <SectionBox title="Release">
        <Row label="Name" value={release.name} />
        <Row label="Namespace" value={release.namespace} />
        <Row label="Status" value={<Chip label={release.info?.status ?? 'unknown'} size="small" color={statusColor(release.info?.status ?? '')} />} />
        <Row label="Revision" value={release.version} />
        <Row label="First Deployed" value={formatDate(release.info?.first_deployed)} />
        <Row label="Last Deployed" value={formatDate(release.info?.last_deployed)} />
        {release.info?.description && <Row label="Description" value={release.info.description} />}
      </SectionBox>
      <SectionBox title="Chart">
        <Row label="Name" value={chart?.name} />
        <Row label="Chart Version" value={chart?.version} />
        <Row label="App Version" value={chart?.appVersion} />
        {chart?.description && <Row label="Description" value={chart.description} />}
        {chart?.home && <Row label="Home" value={<a href={chart.home} target="_blank" rel="noreferrer">{chart.home}</a>} />}
      </SectionBox>
    </>
  );
}

function RevisionsTab({ namespace, name, currentRevision, onRollback, onViewDiff, disabled }: {
  namespace: string; name: string; currentRevision: number;
  onRollback: (revision: number) => void;
  onViewDiff: (revision: HelmRevision) => void;
  disabled: boolean;
}) {
  const { revisions, loading } = useRevisions(namespace, name);
  if (loading) return <Loader title="Loading revisions…" />;
  return (
    <SectionBox title={`Revision History (${revisions.length} revisions)`}>
      <SimpleTable
        columns={[
          {
            label: 'Revision',
            getter: (r: HelmRevision) => (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" fontFamily="monospace">#{r.revision}</Typography>
                {r.revision === currentRevision && <Chip label="current" size="small" color="primary" variant="outlined" />}
              </Box>
            ),
          },
          { label: 'Status', getter: (r: HelmRevision) => <Chip label={r.status} size="small" color={statusColor(r.status)} /> },
          { label: 'Deployed', getter: (r: HelmRevision) => formatDate(r.createdAt) },
          {
            label: 'Actions',
            getter: (r: HelmRevision) => (
              <Box sx={{ display: 'flex', gap: 1 }}>
                {r.revision !== currentRevision && (
                  <ConfirmButton
                    confirmTitle={`Rollback to revision #${r.revision}?`}
                    confirmDescription={`This will roll back "${name}" to revision #${r.revision} in namespace "${namespace}". Resources will be updated and a new revision will be recorded.`}
                    onConfirm={() => onRollback(r.revision)}
                    disabled={disabled} size="small" variant="outlined"
                  >
                    Rollback here
                  </ConfirmButton>
                )}
                {r.revision !== currentRevision && (
                  <Button size="small" variant="text" onClick={() => onViewDiff(r)} disabled={disabled}>
                    View Diff
                  </Button>
                )}
              </Box>
            ),
          },
        ]}
        data={revisions}
      />
    </SectionBox>
  );
}

function ResourcesTab({ release }: { release: HelmRelease }) {
  const resources = parseManifest(release.manifest ?? '');
  if (resources.length === 0) return <SectionBox title="Resources"><Typography color="text.secondary">No resources found in manifest.</Typography></SectionBox>;
  return (
    <SectionBox title={`Resources (${resources.length})`}>
      <SimpleTable
        columns={[
          { label: 'Kind', getter: (r: ManifestResource) => <Chip label={r.kind} size="small" variant="outlined" /> },
          { label: 'Name', getter: (r: ManifestResource) => r.name },
          { label: 'Namespace', getter: (r: ManifestResource) => r.namespace ?? release.namespace },
          { label: 'API Version', getter: (r: ManifestResource) => <Typography variant="body2" fontFamily="monospace" color="text.secondary">{r.apiVersion}</Typography> },
        ]}
        data={resources}
      />
    </SectionBox>
  );
}

function ManifestsTab({ release }: { release: HelmRelease }) {
  return <SectionBox title="Manifests"><CodeBlock>{release.manifest ?? '# No manifest available'}</CodeBlock></SectionBox>;
}

function ValuesTab({ release }: { release: HelmRelease }) {
  const userValues = release.config ?? {};
  const defaultValues = release.chart?.values ?? {};
  const hasUser = Object.keys(userValues).length > 0;
  const hasDefaults = Object.keys(defaultValues).length > 0;
  return (
    <>
      <SectionBox title="User-supplied Values">
        <CodeBlock>{hasUser ? toYaml(userValues) : '# No user-supplied values'}</CodeBlock>
      </SectionBox>
      {hasDefaults && <SectionBox title="Default Values (from chart)"><CodeBlock>{toYaml(defaultValues)}</CodeBlock></SectionBox>}
    </>
  );
}

function NotesTab({ release }: { release: HelmRelease }) {
  return <SectionBox title="Notes"><CodeBlock>{release.info?.notes ?? '# No release notes'}</CodeBlock></SectionBox>;
}

// ── ReleaseDetailContent — reusable, works standalone or inside a dialog ──────

/**
 * All release detail logic, decoupled from routing.
 * @param onClose  Called after a successful uninstall. In the route page this
 *                 navigates back to the list; in a dialog it closes the dialog.
 */
export function ReleaseDetailContent({
  namespace,
  name,
  onClose,
}: {
  namespace: string;
  name: string;
  onClose?: () => void;
}) {
  const { release, loading, error } = useHelmRelease(namespace, name);
  const [op, setOp] = useState<OpState>({ running: false, label: '' });
  const [diffRevision, setDiffRevision] = useState<HelmRevision | null>(null);

  const runOp = async (label: string, fn: () => Promise<void>) => {
    setOp({ running: true, label });
    try {
      await fn();
      setOp({ running: false, label, success: `${label} completed successfully.` });
    } catch (e) {
      setOp({ running: false, label, error: String(e) });
    }
  };

  const handleUninstall = () =>
    runOp('Uninstall', async () => {
      await helmUninstall(namespace, name);
      setTimeout(() => onClose?.(), 1500);
    });

  const handleRollback = (revision: number) =>
    runOp(`Rollback to #${revision}`, () => helmRollback(namespace, name, revision));

  if (loading) return <Loader title="Loading release…" />;

  if (error || !release) {
    return (
      <SectionBox title="Release not found">
        <Typography color="error">{error ?? 'Release not found.'}</Typography>
      </SectionBox>
    );
  }

  return (
    <>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, pt: 2, pb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5" fontWeight={700}>{release.name}</Typography>
        <Chip label={release.info?.status ?? 'unknown'} size="small" color={statusColor(release.info?.status ?? '')} />
        <Chip label={`${release.chart?.metadata?.name} ${release.chart?.metadata?.version}`} size="small" variant="outlined" />
        <Chip label={`Rev #${release.version}`} size="small" variant="outlined" />
        <Box sx={{ flexGrow: 1 }} />

        {op.running && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">{op.label}…</Typography>
          </Box>
        )}

        <ConfirmButton
          confirmTitle={`Uninstall "${release.name}"?`}
          confirmDescription={`This will delete all resources managed by "${release.name}" in namespace "${release.namespace}" and remove its Helm history. This cannot be undone.`}
          onConfirm={handleUninstall}
          disabled={op.running} color="error" variant="outlined" size="small"
        >
          Uninstall
        </ConfirmButton>
      </Box>

      {/* Failed release banner */}
      {release.info?.status === 'failed' && !op.running && !op.error && !op.success && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Alert severity="error">
            <AlertTitle>Release failed</AlertTitle>
            {release.info?.description ?? 'This release did not deploy successfully.'}
            {' '}Open the <strong>Revisions</strong> tab and roll back to a working revision to recover.
          </Alert>
        </Box>
      )}

      {/* Operation banners */}
      {op.success && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Alert severity="success" onClose={() => setOp({ running: false, label: '' })}>{op.success}</Alert>
        </Box>
      )}
      {op.error && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Alert severity="error" onClose={() => setOp({ running: false, label: '' })}>
            <strong>{op.label} failed:</strong> {op.error}
          </Alert>
        </Box>
      )}

      {/* Tabs */}
      <Tabs
        ariaLabel="Release details"
        tabs={[
          { label: 'Overview', component: <OverviewTab release={release} /> },
          {
            label: 'Revisions',
            component: (
              <RevisionsTab
                namespace={namespace}
                name={name}
                currentRevision={release.version}
                onRollback={handleRollback}
                onViewDiff={setDiffRevision}
                disabled={op.running}
              />
            ),
          },
          { label: 'Resources', component: <ResourcesTab release={release} /> },
          { label: 'Manifests', component: <ManifestsTab release={release} /> },
          { label: 'Values', component: <ValuesTab release={release} /> },
          { label: 'Notes', component: <NotesTab release={release} /> },
        ]}
      />

      {diffRevision !== null && (
        <RevisionDiffDialog
          open
          onClose={() => setDiffRevision(null)}
          namespace={namespace}
          releaseName={name}
          currentRelease={release}
          initialCompareRevision={diffRevision}
        />
      )}
    </>
  );
}

// ── Route page wrapper ────────────────────────────────────────────────────────

export function ReleaseDetail() {
  const { namespace, name } = useParams<{ namespace: string; name: string }>();
  const history = useHistory();
  return (
    <ReleaseDetailContent
      namespace={namespace ?? ''}
      name={name ?? ''}
      onClose={() => history.push('/helm/releases')}
    />
  );
}

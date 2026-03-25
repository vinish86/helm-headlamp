import { Link, Loader, SectionBox, Table, TableColumn } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import { HelmRelease, parseManifest, useHelmReleases } from '../helm';

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

export function ReleaseList() {
  const { releases, loading, error } = useHelmReleases();

  const columns = useMemo<TableColumn<HelmRelease>[]>(() => {
    const namespaceOptions = [...new Set(releases.map(r => r.namespace))].sort();
    const statusOptions = [...new Set(releases.map(r => r.info?.status ?? 'unknown'))].sort();
    const kindOptions = [...new Set(
      releases.flatMap(r => parseManifest(r.manifest ?? '').map(res => res.kind))
    )].sort();

    return [
      {
        id: 'name',
        header: 'Name',
        accessorFn: (r: HelmRelease) => r.name,
        Cell: ({ row }: { row: { original: HelmRelease } }) => {
          const r = row.original;
          return (
            <Box>
              <Link
                routeName="secret"
                params={{ namespace: r.namespace, name: r.secretName }}
              >
                {r.name}
              </Link>
              {r.info?.status === 'failed' && (
                <Typography variant="caption" color="error" display="block">
                  Roll back to a working revision to recover
                </Typography>
              )}
            </Box>
          );
        },
      },
      {
        id: 'namespace',
        header: 'Namespace',
        accessorFn: (r: HelmRelease) => r.namespace,
        filterVariant: 'multi-select',
        filterSelectOptions: namespaceOptions,
      },
      {
        id: 'chart',
        header: 'Chart',
        accessorFn: (r: HelmRelease) => r.chart?.metadata?.name ?? '—',
      },
      {
        id: 'chartVersion',
        header: 'Chart Version',
        accessorFn: (r: HelmRelease) => r.chart?.metadata?.version ?? '—',
      },
      {
        id: 'appVersion',
        header: 'App Version',
        accessorFn: (r: HelmRelease) => r.chart?.metadata?.appVersion ?? '—',
      },
      {
        id: 'revision',
        header: 'Revision',
        accessorFn: (r: HelmRelease) => r.version,
      },
      {
        id: 'resources',
        header: 'Resources',
        accessorFn: (r: HelmRelease) => parseManifest(r.manifest ?? '').length,
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r: HelmRelease) => r.info?.status ?? 'unknown',
        filterVariant: 'multi-select',
        filterSelectOptions: statusOptions,
        Cell: ({ row }: { row: { original: HelmRelease } }) => {
          const s = row.original.info?.status ?? 'unknown';
          return <Chip label={s} size="small" color={statusColor(s)} />;
        },
      },
      {
        id: 'lastDeployed',
        header: 'Last Deployed',
        accessorFn: (r: HelmRelease) => formatDate(r.info?.last_deployed),
      },
      // Hidden column — not rendered in the table but drives kind-based filtering.
      // Accessible via the toolbar's "Show Filters" toggle or column visibility menu.
      {
        id: 'kinds',
        header: 'Resource Kind',
        accessorFn: (r: HelmRelease) =>
          [...new Set(parseManifest(r.manifest ?? '').map(res => res.kind))],
        filterVariant: 'multi-select',
        filterSelectOptions: kindOptions,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        enableColumnFilter: true,
      },
    ];
  }, [releases]);

  if (loading) {
    return <Loader title="Loading Helm releases…" />;
  }

  return (
    <SectionBox title="Helm Releases">
      <Table
        columns={columns}
        data={releases}
        emptyMessage={error ?? 'No Helm releases found.'}
        reflectInURL
        initialState={{ columnVisibility: { kinds: false } }}
      />
    </SectionBox>
  );
}

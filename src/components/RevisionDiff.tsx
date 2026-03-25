/**
 * RevisionDiff — revision comparison dialog with From/To dropdowns.
 *
 * Data strategy (proven working):
 * - currentRelease is passed as a prop (decoded by useHelmRelease, no extra fetch).
 * - All other revisions are fetched once on open via the cluster-wide secrets endpoint
 *   (/api/v1/secrets?labelSelector=owner%3Dhelm), filtered client-side — the same
 *   path used by listHelmReleases which is confirmed to populate manifest correctly.
 * - Dropdown changes are instant map lookups, no additional API calls.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Tab from '@mui/material/Tab';
import MuiTabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { HelmRelease, HelmRevision } from '../helm';

// ── Decode (same logic as helm.ts decodeRelease) ──────────────────────────────

async function decodeSecret(b64: string): Promise<HelmRelease> {
  const helmEncoded = atob(b64);
  const binary = atob(helmEncoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(bytes);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(out));
}

/**
 * Fetch and decode ALL revision secrets for a release.
 * Uses the cluster-wide endpoint (same as listHelmReleases).
 * Returns a map of revision number → decoded HelmRelease.
 */
async function fetchAllRevisions(
  namespace: string,
  releaseName: string
): Promise<Map<number, HelmRelease>> {
  const resp: any = await ApiProxy.request('/api/v1/secrets?labelSelector=owner%3Dhelm');
  const items: any[] = resp?.items ?? [];

  const matching = items.filter(
    s => s.metadata?.namespace === namespace && s.metadata?.labels?.name === releaseName
  );

  const result = new Map<number, HelmRelease>();
  await Promise.all(
    matching.map(async s => {
      const revision = parseInt(s.metadata?.labels?.version ?? '0', 10);
      if (!revision || !s.data?.release) return;
      try {
        const rel = await decodeSecret(s.data.release);
        result.set(revision, rel);
      } catch {
        // skip undecodable secrets silently
      }
    })
  );
  return result;
}

// ── Diff algorithm (Myers) ────────────────────────────────────────────────────
// O(n·d) time, O(d·n) space where d = edit distance.
// For typical Helm revision diffs (few changes, large similar files) d is small,
// making this far more efficient than LCS which requires an m×n matrix.

const MAX_EDIT_DISTANCE = 8000;
type DiffLine = { type: 'added' | 'removed' | 'equal'; line: string };
type CollapsedEntry = DiffLine | { type: 'ellipsis'; count: number };

function computeDiff(a: string[], b: string[]): DiffLine[] | 'too-large' {
  const m = a.length, n = b.length;
  const voff = n + 1;
  const vsize = m + n + 3;
  const v = new Int32Array(vsize);
  // trace[d] stores a snapshot of v after processing d edits
  const trace: Int32Array[] = [];

  let found = false;
  outer:
  for (let d = 0; d <= m + n; d++) {
    if (d > MAX_EDIT_DISTANCE) return 'too-large';
    trace.push(v.slice(0, vsize));
    for (let k = -d; k <= d; k += 2) {
      const ki = k + voff;
      let x: number;
      if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) {
        x = v[ki + 1];
      } else {
        x = v[ki - 1] + 1;
      }
      let y = x - k;
      while (x < m && y < n && a[x] === b[y]) { x++; y++; }
      v[ki] = x;
      if (x >= m && y >= n) { found = true; break outer; }
    }
  }

  if (!found) return [];

  // Backtrack through the trace to reconstruct the diff
  const result: DiffLine[] = [];
  let x = m, y = n;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const ki = k + voff;
    let pk: number;
    if (k === -d || (k !== d && vd[ki - 1] < vd[ki + 1])) {
      pk = k + 1;
    } else {
      pk = k - 1;
    }
    const px = vd[pk + voff];
    const py = px - pk;
    while (x > px && y > py) { result.unshift({ type: 'equal', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x > px) { result.unshift({ type: 'removed', line: a[x - 1] }); x--; }
      else { result.unshift({ type: 'added', line: b[y - 1] }); y--; }
    }
  }
  return result;
}

function collapseContext(diff: DiffLine[], ctx = 3): CollapsedEntry[] {
  const n = diff.length;
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    if (diff[i].type !== 'equal')
      for (let k = Math.max(0, i - ctx); k <= Math.min(n - 1, i + ctx); k++) near[k] = 1;
  const out: CollapsedEntry[] = [];
  let i = 0;
  while (i < n) {
    if (near[i] || diff[i].type !== 'equal') { out.push(diff[i]); i++; }
    else {
      let j = i;
      while (j < n && !near[j] && diff[j].type === 'equal') j++;
      out.push({ type: 'ellipsis', count: j - i });
      i = j;
    }
  }
  return out;
}

// ── DiffView ──────────────────────────────────────────────────────────────────

function DiffView({ oldText, newText, label }: { oldText: string; newText: string; label: string }) {
  if (!oldText && !newText)
    return <Alert severity="warning">No {label} data available in either revision.</Alert>;

  const lines = computeDiff((oldText || '').split('\n'), (newText || '').split('\n'));
  if (lines === 'too-large')
    return <Alert severity="info">Content has too many differences to diff inline (exceeded {MAX_EDIT_DISTANCE} edit operations).</Alert>;

  const added = lines.filter(l => l.type === 'added').length;
  const removed = lines.filter(l => l.type === 'removed').length;

  if (added === 0 && removed === 0)
    return <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No {label.toLowerCase()} changes between these revisions.</Typography>;

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
        <Chip label={`+${added}`} size="small" color="success" variant="outlined" />
        <Chip label={`-${removed}`} size="small" color="error" variant="outlined" />
      </Box>
      <Paper variant="outlined" sx={{ overflow: 'auto', maxHeight: 460, fontFamily: 'monospace', fontSize: '0.78rem' }}>
        {collapseContext(lines).map((entry, idx) => {
          if (entry.type === 'ellipsis') return (
            <Box key={idx} sx={{ px: 2, py: 0.3, bgcolor: 'action.hover', color: 'text.disabled', fontStyle: 'italic', userSelect: 'none', borderTop: '1px solid', borderBottom: '1px solid', borderColor: 'divider' }}>
              @@ {entry.count} unchanged line{entry.count !== 1 ? 's' : ''} @@
            </Box>
          );
          const isAdded = entry.type === 'added';
          const isRemoved = entry.type === 'removed';
          return (
            <Box key={idx} sx={{ display: 'flex', alignItems: 'flex-start', bgcolor: isAdded ? 'rgba(46,160,67,0.12)' : isRemoved ? 'rgba(248,81,73,0.12)' : 'transparent' }}>
              <Box component="span" sx={{ width: 24, flexShrink: 0, textAlign: 'center', color: isAdded ? 'success.main' : isRemoved ? 'error.main' : 'transparent', fontWeight: 700, userSelect: 'none', borderRight: '1px solid', borderColor: 'divider', py: 0.1 }}>
                {isAdded ? '+' : isRemoved ? '-' : ' '}
              </Box>
              <Box component="pre" sx={{ m: 0, pl: 1, py: 0.1, flex: 1, color: isAdded ? 'success.dark' : isRemoved ? 'error.dark' : 'text.primary', fontFamily: 'monospace', fontSize: '0.78rem', whiteSpace: 'pre' }}>
                {entry.line || ' '}
              </Box>
            </Box>
          );
        })}
      </Paper>
    </Box>
  );
}

// ── Simple YAML serializer ────────────────────────────────────────────────────

function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') {
    if (obj.includes('\n')) return `|\n${obj.split('\n').map(l => pad + '  ' + l).join('\n')}`;
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (!obj.length) return '[]';
    return obj.map(v => `${pad}- ${toYaml(v, indent + 1)}`).join('\n');
  }
  if (typeof obj === 'object') {
    const es = Object.entries(obj as Record<string, unknown>);
    if (!es.length) return '{}';
    return es.map(([k, v]) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      if (Array.isArray(v) && v.length) return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      return `${pad}${k}: ${toYaml(v, indent + 1)}`;
    }).join('\n');
  }
  return String(obj);
}

// ── RevisionDiffDialog ────────────────────────────────────────────────────────

export interface RevisionDiffDialogProps {
  open: boolean;
  onClose: () => void;
  namespace: string;
  releaseName: string;
  /** Already-decoded current release from useHelmRelease — no extra fetch needed */
  currentRelease: HelmRelease;
  /** Pre-selected "from" revision (the row the user clicked) */
  initialCompareRevision: HelmRevision;
}

export function RevisionDiffDialog({
  open,
  onClose,
  namespace,
  releaseName,
  currentRelease,
  initialCompareRevision,
}: RevisionDiffDialogProps) {
  // Map of revision number → decoded release, pre-loaded on open
  const [revMap, setRevMap] = useState<Map<number, HelmRelease>>(new Map());
  // Sorted list of revision numbers for the dropdowns
  const [revNums, setRevNums] = useState<number[]>([]);

  const [fromRev, setFromRev] = useState(initialCompareRevision.revision);
  const [toRev, setToRev] = useState(currentRelease.version);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    if (!open) return;
    setRevMap(new Map());
    setRevNums([]);
    setFromRev(initialCompareRevision.revision);
    setToRev(currentRelease.version);
    setError(null);
    setTab(0);
    setLoading(true);

    fetchAllRevisions(namespace, releaseName)
      .then(map => {
        // Inject the already-decoded current release so it's available in the map
        // without an extra fetch (it may already be in the map, but this guarantees it)
        map.set(currentRelease.version, currentRelease);

        const sorted = Array.from(map.keys()).sort((a, b) => b - a);
        setRevMap(map);
        setRevNums(sorted);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fromRelease = revMap.get(fromRev) ?? null;
  const toRelease = revMap.get(toRev) ?? null;

  const revLabel = (rev: number) => {
    const rel = revMap.get(rev);
    const status = rel?.info?.status ?? '…';
    return rev === currentRelease.version
      ? `#${rev} (current)`
      : `#${rev} — ${status}`;
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6">Compare Revisions — {releaseName}</Typography>
          <Button onClick={onClose} size="small" variant="outlined">Close</Button>
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        {/* Selectors */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 200 }} disabled={loading || revNums.length === 0}>
            <InputLabel>From (base)</InputLabel>
            <Select
              label="From (base)"
              value={revNums.length > 0 ? fromRev : ''}
              onChange={(e: any) => setFromRev(Number(e.target.value))}
            >
              {revNums.map(rev => (
                <MenuItem key={rev} value={rev}>{revLabel(rev)}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button
            size="small"
            variant="text"
            disabled={loading || revNums.length === 0}
            onClick={() => { setFromRev(toRev); setToRev(fromRev); }}
          >
            ⇄ Swap
          </Button>

          <FormControl size="small" sx={{ minWidth: 200 }} disabled={loading || revNums.length === 0}>
            <InputLabel>To (compare)</InputLabel>
            <Select
              label="To (compare)"
              value={revNums.length > 0 ? toRev : ''}
              onChange={(e: any) => setToRev(Number(e.target.value))}
            >
              {revNums.map(rev => (
                <MenuItem key={rev} value={rev}>{revLabel(rev)}</MenuItem>
              ))}
            </Select>
          </FormControl>

          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            </Box>
          )}
        </Box>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {/* Diff */}
        {!loading && !error && fromRelease && toRelease && (
          <>
            <MuiTabs value={tab} onChange={(_: any, v: number) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
              <Tab label="Manifest" />
              <Tab label="Values" />
            </MuiTabs>
            {tab === 0 && (
              <DiffView
                oldText={fromRelease.manifest ?? ''}
                newText={toRelease.manifest ?? ''}
                label="Manifest"
              />
            )}
            {tab === 1 && (
              <DiffView
                oldText={toYaml(fromRelease.config ?? {})}
                newText={toYaml(toRelease.config ?? {})}
                label="Values"
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

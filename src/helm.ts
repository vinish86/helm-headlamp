import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { useEffect, useState } from 'react';

export interface HelmRelease {
  name: string;
  namespace: string;
  version: number;
  info: {
    status: string;
    first_deployed: string;
    last_deployed: string;
    notes?: string;
    description?: string;
  };
  chart: {
    metadata: {
      name: string;
      version: string;
      appVersion?: string;
      description?: string;
      home?: string;
    };
    values?: Record<string, unknown>;
  };
  config?: Record<string, unknown>;
  manifest?: string;
  secretName: string;
}

export async function decodeRelease(b64: string): Promise<HelmRelease> {
  // K8s API returns data as base64( Helm's base64( gzip( json ) ) )
  // First atob: strip Kubernetes base64 layer → Helm's base64(gzip(json)) string
  // Second atob: strip Helm's base64 layer → raw gzip bytes
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
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }

  return JSON.parse(new TextDecoder().decode(out));
}

export async function listHelmReleases(): Promise<HelmRelease[]> {
  const resp: any = await ApiProxy.request('/api/v1/secrets?labelSelector=owner%3Dhelm');
  const items: any[] = resp?.items ?? [];

  // Keep only the latest revision per release (namespace + name)
  const latest = new Map<string, any>();
  for (const s of items) {
    const relName = s.metadata?.labels?.name;
    if (!relName) continue;
    const key = `${s.metadata.namespace}/${relName}`;
    const v = parseInt(s.metadata?.labels?.version ?? '0', 10);
    const existing = latest.get(key);
    const ev = parseInt(existing?.metadata?.labels?.version ?? '0', 10);
    if (!existing || v > ev) latest.set(key, s);
  }

  const results = await Promise.all(
    Array.from(latest.values()).map(async s => {
      if (!s.data?.release) return null;
      try {
        const rel = await decodeRelease(s.data.release);
        return { ...rel, secretName: s.metadata.name } as HelmRelease;
      } catch {
        return null;
      }
    })
  );

  return results.filter((r): r is HelmRelease => r !== null);
}

export function useHelmReleases() {
  const [releases, setReleases] = useState<HelmRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listHelmReleases()
      .then(setReleases)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [tick]);

  return { releases, loading, error, reload: () => setTick(t => t + 1) };
}

// ── Revision history ────────────────────────────────────────────────────────

export interface HelmRevision {
  revision: number;
  status: string;
  createdAt: string;
  secretName: string;
}

export async function listRevisions(
  namespace: string,
  releaseName: string
): Promise<HelmRevision[]> {
  const url =
    `/api/v1/namespaces/${namespace}/secrets` +
    `?labelSelector=owner%3Dhelm%2Cname%3D${encodeURIComponent(releaseName)}`;
  const resp: any = await ApiProxy.request(url);
  const items: any[] = resp?.items ?? [];
  return items
    .map(s => ({
      revision: parseInt(s.metadata?.labels?.version ?? '0', 10),
      status: s.metadata?.labels?.status ?? 'unknown',
      createdAt: s.metadata?.creationTimestamp ?? '',
      secretName: s.metadata?.name ?? '',
    }))
    .sort((a, b) => b.revision - a.revision);
}

export function useRevisions(namespace: string, name: string) {
  const [revisions, setRevisions] = useState<HelmRevision[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!namespace || !name) return;
    setLoading(true);
    listRevisions(namespace, name)
      .then(setRevisions)
      .finally(() => setLoading(false));
  }, [namespace, name]);

  return { revisions, loading };
}

// ── Manifest parsing ─────────────────────────────────────────────────────────

export interface ManifestResource {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

export function parseManifest(manifest: string): ManifestResource[] {
  if (!manifest) return [];
  const docs = manifest.split(/^---/m).filter(d => d.trim().length > 0);
  const resources: ManifestResource[] = [];
  for (const doc of docs) {
    const apiVersion = doc.match(/^apiVersion:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const kind = doc.match(/^kind:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const name = doc.match(/^\s{0,4}name:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const namespace = doc.match(/^\s{0,4}namespace:\s*(.+)$/m)?.[1]?.trim();
    if (kind && name) resources.push({ apiVersion, kind, name, namespace });
  }
  return resources;
}

// ── Simple YAML serializer ───────────────────────────────────────────────────

export function toYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') {
    if (obj.includes('\n'))
      return `|\n${obj.split('\n').map(l => pad + '  ' + l).join('\n')}`;
    return obj;
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(v => `${pad}- ${toYaml(v, indent + 1)}`).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v))
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        if (Array.isArray(v) && (v as unknown[]).length > 0)
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        return `${pad}${k}: ${toYaml(v, indent + 1)}`;
      })
      .join('\n');
  }
  return String(obj);
}

// ── Single release ────────────────────────────────────────────────────────────

export function useHelmRelease(namespace: string, name: string) {
  const [release, setRelease] = useState<HelmRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!namespace || !name) return;
    setLoading(true);
    setError(null);
    listHelmReleases()
      .then(list => {
        const found = list.find(r => r.namespace === namespace && r.name === name);
        if (!found) setError(`Release "${name}" not found in namespace "${namespace}".`);
        else setRelease(found);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [namespace, name]);

  return { release, loading, error };
}

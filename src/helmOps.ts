/**
 * Helm management operations via direct Kubernetes API calls.
 * All requests go through ApiProxy which uses the current kubeconfig context —
 * no separate service account or RBAC setup is required.
 */

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { decodeRelease, parseManifest } from './helm';

// ── Resource path helpers ─────────────────────────────────────────────────────

// Kinds that live at cluster scope (no namespace in the URL)
const CLUSTER_SCOPED = new Set([
  'ClusterRole',
  'ClusterRoleBinding',
  'ClusterIssuer',
  'ClusterCertificate',
  'PersistentVolume',
  'StorageClass',
  'Namespace',
  'IngressClass',
  'ValidatingWebhookConfiguration',
  'MutatingWebhookConfiguration',
  'CustomResourceDefinition',
  'PriorityClass',
  'RuntimeClass',
]);

// Derive the pluralised REST resource name from a Kind.
// Handles the most common cases; unusual CRDs fall back to kind.toLowerCase()+'s'.
function toResource(kind: string): string {
  const lower = kind.toLowerCase();
  const overrides: Record<string, string> = {
    ingress: 'ingresses',
    networkpolicy: 'networkpolicies',
    storageclass: 'storageclasses',
    endpointslice: 'endpointslices',
    horizontalpodautoscaler: 'horizontalpodautoscalers',
    poddisruptionbudget: 'poddisruptionbudgets',
    replicaset: 'replicasets',
    statefulset: 'statefulsets',
    daemonset: 'daemonsets',
    endpoints: 'endpoints', // already plural — don't add another 's'
  };
  return overrides[lower] ?? (lower.endsWith('s') ? lower : lower + 's');
}

function resourceUrl(
  apiVersion: string,
  kind: string,
  namespace: string | undefined,
  name: string
): string {
  const resource = toResource(kind);
  const ns = CLUSTER_SCOPED.has(kind) ? undefined : namespace;

  if (apiVersion === 'v1') {
    return ns
      ? `/api/v1/namespaces/${ns}/${resource}/${encodeURIComponent(name)}`
      : `/api/v1/${resource}/${encodeURIComponent(name)}`;
  }

  // Split "apps/v1" → group=apps, version=v1; bare "v1beta1" → group='', version=v1beta1
  const slashIdx = apiVersion.indexOf('/');
  const group = slashIdx >= 0 ? apiVersion.slice(0, slashIdx) : '';
  const version = slashIdx >= 0 ? apiVersion.slice(slashIdx + 1) : apiVersion;

  return ns
    ? `/apis/${group}/${version}/namespaces/${ns}/${resource}/${encodeURIComponent(name)}`
    : `/apis/${group}/${version}/${resource}/${encodeURIComponent(name)}`;
}

// ── Helm secret helpers ────────────────────────────────────────────────────────

async function getHelmSecrets(namespace: string, releaseName: string): Promise<any[]> {
  const url =
    `/api/v1/namespaces/${namespace}/secrets` +
    `?labelSelector=owner%3Dhelm%2Cname%3D${encodeURIComponent(releaseName)}`;
  const resp: any = await ApiProxy.request(url);
  return resp?.items ?? [];
}

// Re-encode a release object to the double-base64(gzip(json)) format Helm uses
async function encodeRelease(release: object): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(release));

  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  writer.write(json);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }

  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);

  // Helm layer then K8s layer
  return btoa(btoa(binary));
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export async function helmUninstall(namespace: string, releaseName: string): Promise<void> {
  // 1. Use the latest revision secret regardless of status (deployed or failed).
  //    For a failed release the user should rollback instead; uninstall is a last resort.
  const secrets = await getHelmSecrets(namespace, releaseName);
  if (secrets.length === 0) {
    throw new Error(`No Helm secrets found for "${releaseName}" in "${namespace}"`);
  }

  const latestSecret = secrets.reduce((best, s) =>
    parseInt(s.metadata?.labels?.version ?? '0', 10) >
    parseInt(best.metadata?.labels?.version ?? '0', 10)
      ? s
      : best
  );

  const release = await decodeRelease(latestSecret.data.release);
  const resources = parseManifest(release.manifest ?? '');

  // 2. Delete each managed resource (404 = already gone, skip silently)
  const errors: string[] = [];
  for (const r of resources) {
    const url = resourceUrl(r.apiVersion, r.kind, r.namespace ?? namespace, r.name);
    try {
      await ApiProxy.request(url, { method: 'DELETE' });
    } catch (e: any) {
      const msg = String(e);
      if (!msg.includes('404') && !msg.includes('not found') && !msg.includes('NotFound')) {
        errors.push(`${r.kind}/${r.name}: ${msg}`);
      }
    }
  }

  // 3. Delete all Helm release secrets for this release
  for (const secret of secrets) {
    try {
      await ApiProxy.request(
        `/api/v1/namespaces/${namespace}/secrets/${secret.metadata.name}`,
        { method: 'DELETE' }
      );
    } catch {
      // ignore
    }
  }

  if (errors.length > 0) {
    throw new Error(`Uninstall completed with errors:\n${errors.join('\n')}`);
  }
}

// ── Rollback ──────────────────────────────────────────────────────────────────

// Split a multi-doc manifest into individual YAML document strings
function splitManifest(manifest: string): string[] {
  return manifest
    .split(/^---[ \t]*$/m)
    .map(d => d.trim())
    .filter(d => d.length > 0 && !/^#/.test(d));
}

export async function helmRollback(
  namespace: string,
  releaseName: string,
  targetRevision: number
): Promise<void> {
  const secrets = await getHelmSecrets(namespace, releaseName);

  const findSecret = (v: number) =>
    secrets.find(s => parseInt(s.metadata?.labels?.version ?? '0', 10) === v);

  const deployedSecret = secrets.find(s => s.metadata?.labels?.status === 'deployed');
  if (!deployedSecret) throw new Error('No deployed revision found');

  const currentRevision = parseInt(deployedSecret.metadata?.labels?.version ?? '0', 10);
  const targetSecret = findSecret(targetRevision);
  if (!targetSecret) throw new Error(`Revision ${targetRevision} not found`);

  const currentRelease = await decodeRelease(deployedSecret.data.release);
  const targetRelease = await decodeRelease(targetSecret.data.release);

  // 1. Apply each resource from the target manifest via server-side apply
  const targetDocs = splitManifest(targetRelease.manifest ?? '');
  const applyErrors: string[] = [];

  for (const doc of targetDocs) {
    // Extract just enough metadata to build the URL
    const apiVersion = doc.match(/^apiVersion:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const kind = doc.match(/^kind:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const name = doc.match(/^\s{0,4}name:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const ns = doc.match(/^\s{0,4}namespace:\s*(.+)$/m)?.[1]?.trim();

    if (!kind || !name) continue;

    const url = resourceUrl(apiVersion, kind, ns ?? namespace, name);
    try {
      await ApiProxy.request(`${url}?fieldManager=headlamp-helm&force=true`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/apply-patch+yaml' },
        body: doc,
      });
    } catch (e: any) {
      applyErrors.push(`${kind}/${name}: ${e}`);
    }
  }

  // 2. Delete resources that exist in current but not in target
  const currentResources = parseManifest(currentRelease.manifest ?? '');
  const targetKeys = new Set(
    parseManifest(targetRelease.manifest ?? '').map(r => `${r.kind}/${r.name}`)
  );
  for (const r of currentResources) {
    if (targetKeys.has(`${r.kind}/${r.name}`)) continue;
    const url = resourceUrl(r.apiVersion, r.kind, r.namespace ?? namespace, r.name);
    try {
      await ApiProxy.request(url, { method: 'DELETE' });
    } catch { /* 404 is fine */ }
  }

  // 3. Create a new Helm revision secret that records this rollback
  const newRevision = currentRevision + 1;
  const now = new Date().toISOString();
  const newReleaseData = {
    ...targetRelease,
    version: newRevision,
    info: {
      ...targetRelease.info,
      status: 'deployed',
      last_deployed: now,
      description: `Rollback to revision ${targetRevision}`,
    },
  };

  const encodedRelease = await encodeRelease(newReleaseData);
  const newSecretName = `sh.helm.release.v1.${releaseName}.v${newRevision}`;

  await ApiProxy.request(`/api/v1/namespaces/${namespace}/secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'helm.sh/release.v1',
      metadata: {
        name: newSecretName,
        namespace,
        labels: {
          name: releaseName,
          owner: 'helm',
          status: 'deployed',
          version: String(newRevision),
        },
      },
      data: { release: encodedRelease },
    }),
  });

  // 4. Mark the previously deployed secret as superseded
  await ApiProxy.request(
    `/api/v1/namespaces/${namespace}/secrets/${deployedSecret.metadata.name}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify({
        metadata: { labels: { status: 'superseded' } },
      }),
    }
  );

  if (applyErrors.length > 0) {
    throw new Error(`Rollback completed with errors:\n${applyErrors.join('\n')}`);
  }
}

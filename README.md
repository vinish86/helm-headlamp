# Headlamp Helm Plugin

A Headlamp plugin for viewing and operating Helm releases directly from the Kubernetes API (via Headlamp `ApiProxy`), without requiring shell access to the `helm` CLI inside Headlamp.

## What this plugin provides

- Helm sidebar entry and release list page
- Release details with tabs for:
  - Overview
  - Revisions
  - Resources
  - Manifests
  - Values
  - Notes
- Revision comparison dialog (`Manifest` and `Values` diffs)
- Rollback to a selected previous revision
- Uninstall release resources and Helm history
- Extra details section inside native `Secret` details for Helm secrets (`owner=helm`)

## How it works

Helm v3 stores release history in Kubernetes Secrets (`type: helm.sh/release.v1`) with labels such as:

- `owner=helm`
- `name=<release-name>`
- `version=<revision>`
- `status=<deployed|failed|...>`

This plugin:

1. Lists Helm secrets through Kubernetes API.
2. Decodes release payloads from the Helm secret format (`base64(base64(gzip(json)))`).
3. Builds the UI from decoded release metadata, values, manifests, and revision history.
4. Performs rollback/uninstall by applying/deleting Kubernetes resources and managing Helm revision secrets.

## Navigation

- Sidebar: `Helm` -> `Releases`
- Route: `/helm/releases`
- Release detail route: `/helm/releases/:namespace/:name`
- Also available from native Secret detail pages when the Secret is Helm-owned.

## Operations

### Rollback

- Select a previous revision in the **Revisions** tab.
- Plugin applies target manifest resources using server-side apply.
- Resources not present in the target revision are deleted.
- A new Helm revision secret is created and the previous deployed revision is marked as `superseded`.

### Uninstall

- Deletes resources parsed from the latest release manifest.
- Deletes all Helm revision secrets for that release.
- Reports non-404 deletion errors after operation completes.

## Requirements and permissions

- A Kubernetes cluster with Helm releases stored as Secrets.
- Headlamp access to read/write relevant resources in target namespaces.
- RBAC must allow:
  - `get/list/watch` on Secrets
  - `patch/create/delete` on managed release resources
  - `create/patch/delete` on Secrets for revision and uninstall flows

## Development

This repository contains plugin source in `src/`.

Key files:

- `src/index.tsx`: plugin registration (sidebar, routes, details section)
- `src/helm.ts`: release decoding, listing, manifest parsing, shared hooks
- `src/helmOps.ts`: rollback and uninstall operations
- `src/components/`: UI components and revision diff dialog

For plugin packaging/build/loading workflows, follow the official Headlamp plugin docs:

- [Headlamp Plugin Development](https://headlamp.dev/docs/latest/development/plugins/)
- [Headlamp Plugin API](https://headlamp.dev/docs/latest/development/api/)

## Notes and limitations

- Release data is derived from Helm Secrets; non-standard storage patterns are out of scope.
- Manifest parsing is intentionally lightweight and based on common YAML fields.
- Very large revision diffs may be truncated when edit distance exceeds safety limits.

## License

Apache License 2.0.

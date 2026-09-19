/** A release association needs Helm ownership metadata, not an arbitrary application label. */
export function helmReleaseFor(metadata: {
  namespace?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
}): { name: string; namespace: string } | undefined {
  const labels = metadata.labels ?? {};
  const annotations = metadata.annotations ?? {};
  const name =
    annotations['meta.helm.sh/release-name'] ??
    (labels['heritage'] === 'Helm' || labels['app.kubernetes.io/managed-by'] === 'Helm'
      ? (labels['release'] ?? labels['app.kubernetes.io/instance'])
      : undefined);
  const namespace = annotations['meta.helm.sh/release-namespace'] ?? metadata.namespace;
  return name && namespace ? { name, namespace } : undefined;
}

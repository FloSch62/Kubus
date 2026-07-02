/**
 * Accept certificate material as PEM *or* as the base64 `*-data` value copied
 * out of another kubeconfig — a very easy mix-up that otherwise lands
 * double-encoded in the file and fails with cryptic OpenSSL PEM errors.
 */
export function normalizePemInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('-----BEGIN')) return trimmed;
  try {
    const decoded = atob(trimmed.replace(/\s+/g, ''));
    if (decoded.includes('-----BEGIN')) return decoded.trim();
  } catch {
    /* not base64 — leave as typed and let the server/cluster complain */
  }
  return trimmed;
}

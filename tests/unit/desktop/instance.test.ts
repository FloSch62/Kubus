import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { claimInstance } from '../../../desktop/src/instance.js';

it('hands subsequent launches to the owning instance and releases ownership on exit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kubus-instance-test-'));
  const activate = vi.fn();
  const first = await claimInstance(dir, undefined, activate);
  try {
    expect(first).toBeDefined();
    expect(await claimInstance(dir, 'kubus://r/core/v1/pods', vi.fn())).toBeUndefined();
    expect(activate).toHaveBeenCalledWith('kubus://r/core/v1/pods');
    await new Promise<void>((resolve) => first!.close(() => resolve()));
    const next = await claimInstance(dir, undefined, vi.fn());
    await new Promise<void>((resolve) => next!.close(() => resolve()));
  } finally { first?.close(); rmSync(dir, { recursive: true, force: true }); }
});

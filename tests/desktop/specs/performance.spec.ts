import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchDesktop, type NativePage } from '../helpers/app.js';

const context = process.env.KUBUS_PERF_CONTEXT;
test.skip(!context, 'Set KUBUS_PERF_CONTEXT to run read-only native performance checks.');

declare global {
  interface Window {
    kubusFrameSample?: { until: number; done: Promise<number[]> };
  }
}

async function measure(page: NativePage, action: () => Promise<void>) {
  await page.evaluate(() => {
    const sample = { until: Infinity, done: Promise.resolve([] as number[]) };
    sample.done = new Promise<number[]>(resolve => {
      const frames: number[] = [];
      let last = 0;
      const frame = (now: number) => {
        if (last) frames.push(now - last);
        last = now;
        if (now >= sample.until) resolve(frames);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    window.kubusFrameSample = sample;
  });
  await action();
  return page.evaluate(async () => {
    const sample = window.kubusFrameSample!;
    sample.until = performance.now() + 250;
    const frames = await sample.done;
    frames.sort((a, b) => a - b);
    return { frames: frames.length, meanFps: 1000 * frames.length / frames.reduce((a, b) => a + b, 0), p50: frames[Math.floor(frames.length * .5)]!, p95: frames[Math.floor(frames.length * .95)]!, max: frames.at(-1)!, over33: frames.filter(x => x > 33.4).length };
  });
}

async function stressScroll(page: NativePage) {
  return measure(page, () => page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.MuiDataGrid-virtualScroller')!;
    let direction = 1;
    for (let i = 0; i < 360; i++) {
      await new Promise(requestAnimationFrame);
      if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 30) direction = -1;
      if (scroller.scrollTop <= 0) direction = 1;
      scroller.scrollTop += 25 * direction;
    }
  }));
}

async function visibleNameCell(page: NativePage) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.MuiDataGrid-virtualScroller')!.getBoundingClientRect();
    const row = Array.from(document.querySelectorAll('.MuiDataGrid-row')).find(el => {
      const r = el.getBoundingClientRect(); return r.top > scroller.top + 45 && r.bottom < scroller.bottom;
    })!;
    return `.MuiDataGrid-row[data-rowindex="${row.getAttribute('data-rowindex')}"] [data-field="name"]`;
  });
}

// Playwright requires fixture destructuring even for a native WebDriver session.
// oxlint-disable-next-line eslint/no-empty-pattern
test('native rendering and interactions with a real cluster (read only)', async ({}, info) => {
  test.setTimeout(240_000);
  const kubeconfig = execFileSync('kubectl', ['config', 'view', '--minify', '--flatten', '--raw', '--context', context!], { encoding: 'utf8' });
  const app = await launchDesktop({ kubeconfig });
  const results: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  try {
    const page = app.page;
    await page.click('a[href="/r/core/v1/pods"]');
    await expect.poll(() => page.count('.MuiDataGrid-row')).toBeGreaterThan(5);
    await expect.poll(() => page.evaluate(async context => {
      const response = await fetch(`/api/contexts/${encodeURIComponent(context!)}/metrics/pods`, { headers: { authorization: `Bearer ${sessionStorage.getItem('kubus-token')}` } });
      const metrics = await response.json();
      return metrics.available && metrics.items.length > 0;
    }, context), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll('.MuiDataGrid-row [data-field="memUsage"], .MuiDataGrid-row .kubus-usage-value')).some(el => /[0-9]/.test(el.textContent ?? ''))), { timeout: 10_000 }).toBe(true);
    // Let discovery and initial metric responses finish before sustained input.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
    results.scrollStress = await stressScroll(page);
    const { before, delta } = await page.evaluate(() => {
      const scroller = document.querySelector('.MuiDataGrid-virtualScroller')!;
      const before = scroller.scrollTop;
      const below = scroller.scrollHeight - scroller.clientHeight - before;
      return { before, delta: Math.round((below > before ? 1 : -1) * Math.min(2400, Math.max(below, before) * .8)) };
    });
    results.wheel = await measure(page, () => page.wheel('.MuiDataGrid-virtualScroller', delta));
    const after = await page.evaluate(() => document.querySelector('.MuiDataGrid-virtualScroller')!.scrollTop);
    expect(Math.abs(after - before)).toBeGreaterThan(500);
    expect(Math.abs(after - before - delta)).toBeLessThan(3);
    await page.evaluate(() => {
      const control = document.createElement('div');
      control.id = 'scroll-control';
      control.style.cssText = 'position:fixed;inset:150px;z-index:99999;overflow:auto;background:white';
      control.innerHTML = '<div style="height:12000px;background:repeating-linear-gradient(white 0px, white 39px, lightgray 40px)">Native scroll control</div>';
      document.body.append(control);
    });
    results.wheelControl = await measure(page, () => page.wheel('#scroll-control', 2400));
    await page.evaluate(() => document.getElementById('scroll-control')!.remove());
    const cell = await visibleNameCell(page);
    results.openDetails = await measure(page, () => page.click(cell));
    await expect.poll(() => page.visible('aside[aria-label="Resource details"]')).toBe(true);
    await page.screenshot(info.outputPath('native-pod-details.png'));
    // Overview must not start Monaco or the YAML language worker.
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/(?:monaco|yaml\.worker)-/.test(new URL(entry.name).pathname)))).toBe(false);
    results.collapse = await measure(page, () => page.click('button[aria-label="Collapse resource details"]'));
    results.expand = await measure(page, () => page.click('button[aria-label="Expand resource details"]'));
    results.detailScroll = await stressScroll(page);
    const detailWidth = () => page.evaluate(() => document.querySelector('aside')!.getBoundingClientRect().width);
    const originalWidth = await detailWidth();
    results.resizeDetails = await measure(page, () => page.drag('button[aria-label="Collapse resource details"]', -80, 0));
    expect(Math.abs(await detailWidth() - originalWidth - 80)).toBeLessThan(3);
    await page.drag('button[aria-label="Collapse resource details"]', 80, 0);
    expect(Math.abs(await detailWidth() - originalWidth)).toBeLessThan(3);
    expect(await page.visible('button[aria-label="Collapse resource details"]')).toBe(true);
    results.closeDetails = await measure(page, () => page.click('button[aria-label="Close resource details"]'));
    results.hideNavigation = await measure(page, () => page.click('button[aria-label="Toggle navigation"]'));
    results.showNavigation = await measure(page, () => page.click('button[aria-label="Toggle navigation"]'));
    // Native checkbox input, keyboard navigation and detail focus handoff.
    await page.click((await visibleNameCell(page)).replace('[data-field="name"]', 'input[type="checkbox"]'));
    await expect.poll(() => page.count('.MuiDataGrid-row input:checked')).toBe(1);
    await page.click('.MuiDataGrid-row input:checked');
    await page.click(await visibleNameCell(page));
    await page.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.closest('.MuiDataGrid-cell') !== null)).toBe(true);
    await page.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Resource details');
    await page.press('Escape');
    await expect.poll(() => page.count('aside[aria-label="Resource details"]')).toBe(0);
    const name = await page.evaluate(css => document.querySelector(css)!.textContent!.trim(), await visibleNameCell(page));
    results.filter = await measure(page, () => page.fill('input[placeholder="Search… type / for smart filter"]', name));
    await expect.poll(() => page.count('.MuiDataGrid-row')).toBe(1);
    await page.fill('input[placeholder="Search… type / for smart filter"]', '');
    await expect.poll(() => page.count('.MuiDataGrid-row')).toBeGreaterThan(5);
    // Large jumps must replenish the visible rows in both directions.
    for (const fraction of [1, 0, .75, .25]) {
      await page.evaluate(fraction => {
        const scroller = document.querySelector('.MuiDataGrid-virtualScroller')!;
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction;
      }, fraction);
      await expect.poll(() => page.evaluate(() => {
        const scroller = document.querySelector('.MuiDataGrid-virtualScroller')!.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('.MuiDataGrid-row')).map(el => el.getBoundingClientRect());
        return rows.some(r => r.top <= scroller.top + 70 && r.bottom > scroller.top + 70)
          && rows.some(r => r.top < scroller.bottom - 25 && r.bottom >= scroller.bottom - 25);
      })).toBe(true);
    }
    const horizontal = await page.evaluate(() => {
      const scroller = document.querySelector('.MuiDataGrid-virtualScroller')!;
      return scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft;
    });
    expect(horizontal).toBeGreaterThan(100);
    results.horizontalScroll = await measure(page, () => page.wheel('.MuiDataGrid-virtualScroller', 0, horizontal));
    await expect.poll(() => page.evaluate(() => {
      const scroller = document.querySelector('.MuiDataGrid-virtualScroller')!;
      return Math.abs(scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft);
    })).toBeLessThan(3);
    const row = (await visibleNameCell(page)).replace(' [data-field="name"]', '');
    await page.moveTo(`${row} [data-field="age"] [data-kubus-tooltip] > *`);
    await expect.poll(() => page.count('[role="tooltip"]')).toBe(1);
    expect(await page.evaluate(() => document.querySelector('[role="tooltip"]')!.textContent!.length)).toBeGreaterThan(5);
    await page.click(`${row} button[aria-label^="Logs for "]`);
    await expect.poll(() => page.visible('[aria-label="Log output"]')).toBe(true);
    await expect.poll(() => page.count('[aria-label="Log output"] [data-idx]'), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.screenshot(info.outputPath('native-pod-logs.png'));
    await page.click('.kubus-bottom-dock [role="button"][aria-label^="Close "]');
    await page.wheel('.MuiDataGrid-virtualScroller', 0, -horizontal);
    await expect.poll(() => page.evaluate(() => document.querySelector('.MuiDataGrid-virtualScroller')!.scrollLeft)).toBeLessThan(3);
    for (const [label, route] of [['nodes', '/r/core/v1/nodes'], ['deployments', '/r/apps/v1/deployments'], ['services', '/r/core/v1/services'], ['events', '/events'], ['pods', '/r/core/v1/pods']] as const) {
      results[label] = await measure(page, () => page.click(`a[href="${route}"]`));
      await expect.poll(() => page.count('.MuiDataGrid-row')).toBeGreaterThan(0);
    }
    // Guard the measured hot paths. The plain overflow control captures the
    // driver's/display's own pacing; compositor animation has a separate test.
    for (const sample of [results.scrollStress!, results.detailScroll!]) {
      expect(sample.p50).toBeLessThan(21);
      expect(sample.p95).toBeLessThan(33.4);
      expect(sample.max).toBeLessThan(100);
    }
    expect(results.wheel!.p95).toBeLessThanOrEqual(Math.max(40, results.wheelControl!.p95 + 17));
    expect(results.wheel!.over33 / results.wheel!.frames).toBeLessThan(.25);
    expect(results.openDetails!.max).toBeLessThan(200);
  } finally {
    console.log(JSON.stringify(results, null, 2));
    const reportPath = info.outputPath('native-performance.json');
    writeFileSync(reportPath, JSON.stringify({ context, results }, null, 2));
    await info.attach('native-performance.json', { path: reportPath, contentType: 'application/json' });
    await app.close();
  }
});

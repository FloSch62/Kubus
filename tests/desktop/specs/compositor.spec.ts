import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchDesktop } from '../helpers/app.js';

const context = process.env.KUBUS_PERF_CONTEXT;
test.skip(!context || process.env.KUBUS_PERF_CAPTURE !== '1', 'Opt in with KUBUS_PERF_CONTEXT and KUBUS_PERF_CAPTURE=1 on an X11 display.');

// Sample the native window: JS animation-frame delays cannot tell us whether
// the compositor continued moving a layer while React was busy.
// oxlint-disable-next-line eslint/no-empty-pattern
test('detail drawer moves across consecutive compositor frames', async ({}, info) => {
  test.setTimeout(60_000);
  const kubeconfig = execFileSync('kubectl', ['config', 'view', '--minify', '--flatten', '--raw', '--context', context!], { encoding: 'utf8' });
  const app = await launchDesktop({ kubeconfig });
  let capture: ReturnType<typeof spawn> | undefined;
  try {
    const page = app.page;
    await page.click('a[href="/r/core/v1/pods"]');
    await expect.poll(() => page.count('.MuiDataGrid-row')).toBeGreaterThan(5);
    await page.click('.MuiDataGrid-row [data-field="name"]');
    await expect.poll(() => page.count('aside .MuiButton-root')).toBeGreaterThan(2);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1200)));
    await page.evaluate(() => { const panel = document.querySelector('aside')!.lastElementChild as HTMLElement; panel.style.borderLeft = '3px solid rgb(255,0,255)'; });
    const active = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { encoding: 'utf8' }).match(/0x[0-9a-f]+/i)![0];
    expect(execFileSync('xprop', ['-id', active, 'WM_CLASS'], { encoding: 'utf8' })).toMatch(/kubus/i);
    const icon = execFileSync('xprop', ['-id', active, '-notype', '-f', '_NET_WM_ICON', '32c', '_NET_WM_ICON'], { encoding: 'utf8' });
    expect(icon).toMatch(/= 128, 128,/);
    const geometry = execFileSync('xwininfo', ['-id', active], { encoding: 'utf8' });
    const field = (name: string) => Number(geometry.match(new RegExp(`${name}:\\s+(-?\\d+)`))![1]);
    const width = field('Width'), height = field('Height');
    const file = info.outputPath('compositor.rgb');
    capture = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '60', '-window_id', active, '-video_size', `${width}x${height}`, '-i', process.env.DISPLAY!, '-t', '2', '-vf', `crop=${width}:2:0:450`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    const done = new Promise<number | null>(resolve => capture!.on('exit', resolve));
    let errors = ''; capture.stderr!.on('data', chunk => { errors += String(chunk); });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    await page.click('button[aria-label="Collapse resource details"]');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
    await page.click('button[aria-label="Expand resource details"]');
    expect(await done, errors).toBe(0);
    const frames = readFileSync(file), stride = width * 2 * 3;
    const positions: number[] = [];
    for (let f = 0; f < frames.length; f += stride) {
      let found = -1;
      for (let col = 0; col < width; col++) {
        const offset = f + col * 3;
        if (frames[offset]! > 240 && frames[offset + 1]! < 30 && frames[offset + 2]! > 240) { found = col; break; }
      }
      positions.push(found);
    }
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    const initial = positions[0]!;
    const hidden = positions.indexOf(-1);
    const collapseStart = positions.findIndex(x => x > initial + 2);
    const expandStart = positions.findIndex((x, i) => i > hidden && x >= 0);
    const expanded = positions.findIndex((x, i) => i > expandStart && Math.abs(x - initial) <= 2);
    expect(collapseStart).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(collapseStart);
    expect(expandStart).toBeGreaterThan(hidden);
    expect(expanded).toBeGreaterThan(expandStart);
    const motion = (samples: number[]) => {
      let longestHold = 1, hold = 1;
      samples.forEach((x, i) => { hold = i && x === samples[i - 1] ? hold + 1 : 1; longestHold = Math.max(longestHold, hold); });
      return { distinctPositions: new Set(samples).size, longestHoldMs: longestHold * 1000 / 60 };
    };
    const collapse = motion(positions.slice(collapseStart, hidden));
    const expand = motion(positions.slice(expandStart, expanded + 1));
    const report = { context, width, positions, collapse, expand };
    console.log(JSON.stringify(report));
    const reportPath = info.outputPath('compositor.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await info.attach('compositor.json', { path: reportPath, contentType: 'application/json' });
    for (const movement of [collapse, expand]) {
      expect(movement.distinctPositions).toBeGreaterThanOrEqual(5);
      expect(movement.longestHoldMs).toBeLessThanOrEqual(50);
    }
    expect(positions.at(-1)).toBe(initial);
  } finally {
    if (capture && capture.exitCode === null) capture.kill('SIGTERM');
    await app.close();
  }
});

// oxlint-disable-next-line eslint/no-empty-pattern
test('native wheel scroll has no blank viewport or sustained compositor freeze', async ({}, info) => {
  test.setTimeout(60_000);
  const kubeconfig = execFileSync('kubectl', ['config', 'view', '--minify', '--flatten', '--raw', '--context', context!], { encoding: 'utf8' });
  const app = await launchDesktop({ kubeconfig });
  let capture: ReturnType<typeof spawn> | undefined;
  try {
    const page = app.page;
    await page.click('a[href="/r/core/v1/pods"]');
    await expect.poll(() => page.count('.MuiDataGrid-row')).toBeGreaterThan(5);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
    const strip = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.MuiDataGrid-row { background-image: linear-gradient(magenta,magenta) !important; background-size: 100% 2px !important; background-position: top !important; background-repeat: no-repeat !important; }';
      document.head.append(style);
      const rect = document.querySelector('.MuiDataGrid-virtualScroller')!.getBoundingClientRect();
      return { x: Math.ceil(rect.left + 8), y: Math.ceil(rect.top + 70), height: Math.floor(rect.height - 100), rowHeight: document.querySelector('.MuiDataGrid-row')!.getBoundingClientRect().height };
    });
    const active = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { encoding: 'utf8' }).match(/0x[0-9a-f]+/i)![0];
    expect(execFileSync('xprop', ['-id', active, 'WM_CLASS'], { encoding: 'utf8' })).toMatch(/kubus/i);
    const geometry = execFileSync('xwininfo', ['-id', active], { encoding: 'utf8' });
    const field = (name: string) => Number(geometry.match(new RegExp(`${name}:\\s+(-?\\d+)`))![1]);
    const file = info.outputPath('scroll-compositor.rgb');
    capture = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '60', '-window_id', active, '-video_size', `${field('Width')}x${field('Height')}`, '-i', process.env.DISPLAY!, '-t', '3.5', '-vf', `crop=2:${strip.height}:${strip.x}:${strip.y}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    const done = new Promise<number | null>(resolve => capture!.on('exit', resolve));
    let errors = ''; capture.stderr!.on('data', chunk => { errors += String(chunk); });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    const before = await page.evaluate(() => document.querySelector('.MuiDataGrid-virtualScroller')!.scrollTop);
    await page.wheel('.MuiDataGrid-virtualScroller', 960);
    const after = await page.evaluate(() => document.querySelector('.MuiDataGrid-virtualScroller')!.scrollTop);
    expect(Math.abs(after - before - 960)).toBeLessThan(3);
    expect(await done, errors).toBe(0);
    const frames = readFileSync(file), stride = 2 * strip.height * 3;
    const positions: number[] = [];
    for (let f = 0; f < frames.length; f += stride) {
      let found = -1;
      for (let row = 0; row < strip.height; row++) {
        const offset = f + row * 2 * 3;
        if (frames[offset]! > 240 && frames[offset + 1]! < 30 && frames[offset + 2]! > 240) { found = row; break; }
      }
      positions.push(found);
    }
    expect(positions.length).toBeGreaterThan(150);
    expect(positions.every(x => x >= 0 && x <= strip.rowHeight)).toBe(true);
    const changes = positions.flatMap((x, i) => i && x !== positions[i - 1] ? [i] : []);
    expect(changes.length).toBeGreaterThan(70);
    const longestHoldMs = Math.max(...changes.slice(1).map((frame, i) => frame - changes[i]!)) * 1000 / 60;
    const report = { context, strip, positions, changedFrames: changes.length, longestHoldMs, scrolled: after - before };
    console.log(JSON.stringify(report));
    const reportPath = info.outputPath('scroll-compositor.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await info.attach('scroll-compositor.json', { path: reportPath, contentType: 'application/json' });
    expect(longestHoldMs).toBeLessThanOrEqual(50);
  } finally {
    if (capture && capture.exitCode === null) capture.kill('SIGTERM');
    await app.close();
  }
});

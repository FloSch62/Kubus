import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { appendAppLog } from '@kubus/server';

/**
 * Main-process diagnostics. Every entry goes to the in-process viewer buffer
 * and to a plain-text file that survives failures before a window can open.
 */
const MAX_LOG_BYTES = 1024 * 1024;

let logFile: string | undefined;

export function initMainLog(userDataDir: string): void {
  try {
    const dir = path.join(userDataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, path.join(dir, 'main.old.log'));
    } catch {
      // First run: no file yet.
    }
    logFile = file;
  } catch {
    // Diagnostics never block startup; the in-memory mirror still works.
  }
}

export function mainLogPath(): string | undefined {
  return logFile;
}

function describeError(err: unknown): string | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') return String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

export function mainLog(level: 'info' | 'warn' | 'error', msg: string, err?: unknown): void {
  const detail = describeError(err);
  appendAppLog(level, msg, detail ? { err: detail } : undefined);
  if (!logFile) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${detail ? `\n  ${detail.replaceAll('\n', '\n  ')}` : ''}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    // Never let logging take the app down.
  }
}

/** Last-resort capture: observe fatal main-process errors without handling them. */
export function installCrashCapture(): void {
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    mainLog(
      'error',
      origin === 'unhandledRejection' ? 'unhandled promise rejection in the main process' : 'uncaught exception in the main process',
      err,
    );
  });
}

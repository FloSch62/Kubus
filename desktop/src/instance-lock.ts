import { closeSync, openSync } from 'node:fs';
import { constants } from 'node:os';
import { dlopen, read } from 'bun:ffi';

const mac = process.platform === 'darwin';
const errnoSymbol = mac ? '__error' : '__errno_location';
const libc = dlopen(mac ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
  [errnoSymbol]: { args: [], returns: 'ptr' },
});

/** Keep the file in place: unlinking it would let contenders lock different inodes. */
export function tryInstanceLock(file: string): (() => void) | undefined {
  const fd = openSync(file, 'a', 0o600);
  if (libc.symbols.flock!(fd, 2 | 4) === 0) { // LOCK_EX | LOCK_NB on Linux and macOS.
    return () => closeSync(fd); // The kernel also releases the lock after a crash.
  }
  const errno = read.i32(libc.symbols[errnoSymbol]!()!);
  closeSync(fd);
  if (errno === constants.errno.EWOULDBLOCK) return undefined;
  throw new Error(`Could not lock the Kubus instance file (errno ${errno}).`);
}

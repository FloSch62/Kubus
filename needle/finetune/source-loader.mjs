// Run browser TypeScript contracts directly under Node without emitting JS into src.
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js') || !context.parentURL?.includes('/client/src/needle/')) throw error;
    return nextResolve(specifier.slice(0, -3) + '.ts', context);
  }
} });

import { loadConfig } from './config.js';
import { startServer } from './server.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

let server;
try {
  server = await startServer(config);
} catch (err) {
  console.error(err);
  process.exit(1);
}

if (config.auth === 'none') {
  server.app.log.warn('authentication disabled (--auth none): the reverse proxy in front of Kubus must authenticate users');
}
server.app.log.info(`Kubus ready at ${server.url}`);
for (const origin of config.allowedOrigins) server.app.log.info(`accepting browser origin ${origin}`);

if (config.openBrowser) {
  const { default: open } = await import('open');
  await open(server.url).catch(() => {
    /* headless environments: URL is already logged */
  });
}

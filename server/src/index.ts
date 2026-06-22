import { loadConfig } from './config.js';
import { startServer } from './server.js';

const config = loadConfig();

let server;
try {
  server = await startServer(config);
} catch (err) {
  console.error(err);
  process.exit(1);
}

server.app.log.info(`Kubus ready at ${server.url}`);

if (config.openBrowser) {
  const { default: open } = await import('open');
  await open(server.url).catch(() => {
    /* headless environments: URL is already logged */
  });
}

import { claimInstance } from '../../../desktop/src/instance.js';

console.log('ready');
process.stdin.once('data', async () => {
  const server = await claimInstance(process.argv[2]!, undefined, () => console.log('activate'));
  console.log(server ? 'owner' : 'forwarded');
  if (!server) process.exit(0);
  process.stdin.on('end', () => server.close(() => process.exit(0)));
});

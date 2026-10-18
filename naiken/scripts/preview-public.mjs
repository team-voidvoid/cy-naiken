import { spawn } from 'node:child_process';
import { createPublicEgress } from '../build/public-egress.mjs';

const egress = await createPublicEgress();
const child = spawn(process.execPath, ['--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'dist/server/wrangler.json',
  '--local', '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--inspector-port', '0',
  '--var', `NAIKEN_PUBLIC_EGRESS_URL:${egress.url}`, ...process.argv.slice(2)], {stdio:'inherit'});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', async code => { await egress.dispose(); process.exitCode = code ?? 1; });

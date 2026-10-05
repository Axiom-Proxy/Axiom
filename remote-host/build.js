'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { LightDeskClient, normalizeServerUrl } = require('./client/core');

// This is a BYOD app: the person running the host supplies their own Axiom
// address on first launch. AXIOM_REMOTE_URL remains an optional development
// convenience, not a build requirement.
let server = '';
if (process.env.AXIOM_REMOTE_URL) {
  const url = new URL(normalizeServerUrl(process.env.AXIOM_REMOTE_URL));
  url.pathname = '/remote-desktop/ws';
  url.search = '';
  url.hash = '';
  if (url.protocol !== 'wss:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    console.error('The remote desktop address must use HTTPS.');
    process.exit(1);
  }
  server = url.toString();
  console.log(`Remote desktop server: ${url.origin}`);
} else {
  console.log('No default Axiom address configured; the user will enter one on first launch.');
}

fs.writeFileSync(path.join(__dirname, 'client', 'default-server.json'), JSON.stringify({ server }, null, 2) + '\n');

const compiler = LightDeskClient.findCsc();
if (!compiler) {
  console.error('The Windows .NET Framework compiler is required to build the host.');
  process.exit(1);
}
const clientDir = path.join(__dirname, 'client');
const binDir = path.join(clientDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const output = path.join(binDir, 'LightDeskHelper.exe');
const result = spawnSync(compiler, [
  '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/unsafe+',
  '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  `/out:${output}`, path.join(clientDir, 'LightDeskHelper.cs'),
], { encoding: 'utf8' });
if (result.status !== 0 || !fs.existsSync(output)) {
  console.error((result.stdout || '') + (result.stderr || ''));
  process.exit(1);
}
console.log('Windows host component built.');

console.log('Packaging Windows app...');
const builder = path.join(
  __dirname,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);
const packaged = spawnSync(builder, ['--win', 'portable'], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (packaged.status !== 0) process.exit(packaged.status || 1);

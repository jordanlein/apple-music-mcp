#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const usage = 'Usage: node scripts/mcp-connection.mjs https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev\nReads your existing MCP_API_KEY (or POKE_MCP_API_KEY override) privately from stdin.\nSaves the capability URL and equivalent bearer configuration to ignored work/mcp-connection.json.';
if (process.argv.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
try {
  if (process.argv.length !== 3) throw new Error(usage);
  const origin = new URL(process.argv[2]);
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.workers.dev') || origin.username || origin.password || origin.port || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Use the HTTPS workers.dev origin only, without a path, port, query, or credentials.');
  }
  const secret = await readSecret();
  if (secret.length < 32) throw new Error('The existing key must contain at least 32 characters.');
  const token = createHash('sha256').update(secret).digest('hex');
  const output = resolve('work/mcp-connection.json');
  await mkdir(resolve('work'), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify({
    url: `${origin.origin}/mcp/${token}`,
    transport: 'streamable-http',
    authType: 'none',
    bearerAlternative: {
      url: `${origin.origin}/mcp`,
      headers: { Authorization: `Bearer ${token}` }
    }
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('Saved private connection settings to work/mcp-connection.json. Keep this file out of Git and shared logs.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to create connection settings.');
  process.exitCode = 1;
}

async function readSecret() {
  if (process.stdin.isTTY) {
    process.stderr.write('Existing MCP key (hidden): ');
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding('utf8');
  return new Promise((resolveSecret, reject) => {
    let value = '';
    const terminal = process.stdin.isTTY;
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.off('end', finish);
      if (terminal) { process.stdin.setRawMode(false); process.stderr.write('\n'); }
      process.stdin.pause();
      resolveSecret(value.trim());
    };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') {
          process.stdin.off('data', onData);
          process.stdin.off('end', finish);
          if (terminal) { process.stdin.setRawMode(false); process.stderr.write('\n'); }
          process.stdin.pause();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\n' || char === '\r') { finish(); return; }
        if (terminal && (char === '\u007f' || char === '\b')) value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
    process.stdin.resume();
  });
}

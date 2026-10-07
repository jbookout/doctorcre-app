// Checks journey-test locators against live signed-in staging through `e2e mcp`
// (topic `mcp`: open_session, navigate, locate, close_session), the documented
// way to confirm a locator resolves to exactly one node before a test uses it.
// Usage: node scripts/e2e-staging/mcp-locate.mjs tests/staging/locators.json [target]
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const [file = 'tests/staging/locators.json', target = 'staging'] = process.argv.slice(2);
const plan = JSON.parse(await readFile(file, 'utf8'));
const child = spawn('npx', ['e2e', 'mcp', '--config', 'e2e.staging.config.ts', '--target', target, '--headless', '--max-sessions', '1'], {
  env: { ...process.env, E2E_STAGING_MCP_SESSION: '1', E2E_TELEMETRY_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, msg => msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const tool = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args });
  return (result.content || []).map(part => part.text || '').join('\n');
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctorcre-locator-check', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const opened = await tool('open_session', { target });
const session = /session[^\w]*["']?([\w-]{6,})/i.exec(opened)?.[1];
const results = [];
for (const page of plan) {
  await tool('call', { session, tool: 'navigate', args: { url: page.path } });
  for (const locator of page.locators) {
    // Pages render after their record-layer read lands; give a 0-match answer
    // up to three more looks, two seconds apart, before calling it missing.
    let text = await tool('call', { session, tool: 'locate', args: locator });
    for (let retry = 0; retry < 3 && /^\s*0\s+node/i.test(text); retry++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      text = await tool('call', { session, tool: 'locate', args: locator });
    }
    const matches = /(\d+)\s+(?:node|match)/i.exec(text)?.[1];
    results.push({ path: page.path, locator, matches: matches === undefined ? null : Number(matches), ok: /^\s*1\s/m.test(text) || /exactly one|1 match|1 node/i.test(text), text: text.slice(0, 400) });
  }
}
await tool('close_session', { session });
child.kill();
await mkdir('.e2e/mcp', { recursive: true });
await writeFile(`.e2e/mcp/locators-${target}.json`, JSON.stringify(results, null, 2));
const bad = results.filter(row => !row.ok);
console.log(`${results.length - bad.length}/${results.length} locators resolve to exactly one node on ${target}`);
for (const row of bad) console.log('NOT UNIQUE', row.path, JSON.stringify(row.locator), '->', row.text.split('\n')[0]);
process.exit(0);

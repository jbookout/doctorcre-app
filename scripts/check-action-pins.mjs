import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkActionPins(root = fileURLToPath(new URL('../', import.meta.url))) {
  const manifest = JSON.parse(await readFile(join(root, '.github/action-pins.json'), 'utf8'));
  assert.equal(manifest.schema, 'workflow-action-provenance.v1');
  assert.ok(manifest.actions && typeof manifest.actions === 'object' && !Array.isArray(manifest.actions));
  const runtimes = {
    'actions/checkout': 'node24',
    'actions/setup-node': 'node24',
    'actions/upload-artifact': 'node24',
    'actions/download-artifact': 'node24',
    'actions/setup-python': 'node20',
  };
  const check = (action, sha, label = action) => {
    assert.ok(Object.hasOwn(runtimes, action), `unverified action: ${action}`);
    const pin = manifest.actions[action];
    assert.match(sha, /^[a-f0-9]{40}$/, label);
    assert.equal(pin.sha, sha, label);
    assert.equal(pin.canonical_tag_sha, sha, label);
    assert.match(pin.tag, /^v\d+\.\d+\.\d+$/, label);
    assert.equal(pin.release_url, `https://github.com/${action}/releases/tag/${pin.tag}`, label);
    assert.equal(pin.tag_url, `https://api.github.com/repos/${action}/git/refs/tags/${pin.tag}`, label);
    assert.match(pin.metadata_blob, /^[a-f0-9]{40}$/, label);
    assert.equal(pin.runtime, runtimes[action], label);
  };
  for (const [action, pin] of Object.entries(manifest.actions)) check(action, pin.sha);
  const directory = join(root, '.github/workflows');
  const names = (await readdir(directory)).filter(name => /\.ya?ml$/.test(name)).sort();
  assert.ok(names.length, 'no workflows were checked');
  for (const name of names) {
    const source = await readFile(join(directory, name), 'utf8');
    for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\r\n]*)/gm)) {
      const value = match[1].split(/\s+#/)[0].trim();
      const ref = value.replace(/^(['"])(.*)\1$/, '$2');
      if (ref.startsWith('./')) continue;
      const [action, sha] = ref.split('@');
      const label = `${name}: ${action}`;
      assert.match(ref, /^[^@\s]+@[a-f0-9]{40}$/, `${label} must use an immutable commit`);
      assert.ok(manifest.actions[action], `${label} has no recorded provenance`);
      check(action, sha, label);
    }
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkActionPins();
    console.log('workflow action pins match recorded release evidence');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// doctrine: engineering-workflow-sop
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkActionPins(root = fileURLToPath(new URL('../', import.meta.url))) {
  const manifest = JSON.parse(await readFile(join(root, '.github/action-pins.json'), 'utf8'));
  assert.equal(manifest.schema, 'workflow-action-provenance.v1');
  assert.ok(manifest.actions && typeof manifest.actions === 'object' && !Array.isArray(manifest.actions));
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
      assert.match(sha ?? '', /^[a-f0-9]{40}$/, `${label} must use an immutable commit`);
      const pin = manifest.actions[action];
      assert.ok(pin, `${label} has no recorded provenance`);
      assert.equal(pin.sha, sha, `${label} differs from recorded release; update the workflow and provenance together`);
      assert.equal(pin.canonical_tag_sha, sha, `${label} differs from canonical tag evidence`);
      assert.equal(pin.release_url, `https://github.com/${action}/releases/tag/${pin.tag}`, label);
      assert.match(pin.metadata_blob, /^[a-f0-9]{40}$/, label);
      assert.equal(pin.runtime, 'node20', label);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await checkActionPins();
    console.log('workflow action pins match recorded release evidence');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

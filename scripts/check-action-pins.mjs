import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkActionPins(root = fileURLToPath(new URL('../', import.meta.url))) {
  root = await realpath(root);
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
  const visited = new Set();
  const inspect = async file => {
    file = await realpath(file);
    assert.ok(file.startsWith(root + sep), 'local action must stay inside repository');
    if (visited.has(file)) return;
    visited.add(file);
    const document = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-rdate', '-e',
      'puts JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [Date, Time], aliases: true))'], {
      input: await readFile(file, 'utf8'), encoding: 'utf8', timeout: 900_000, stdio: ['pipe', 'pipe', 'pipe'],
    }));
    const jobs = Object.values(document.jobs ?? {});
    for (const entry of [...jobs, ...jobs.flatMap(job => job.steps ?? []), ...(document.runs?.steps ?? [])]) {
      if (!Object.hasOwn(entry, 'uses')) continue;
      const ref = entry.uses;
      const label = `${file}: ${ref}`;
      assert.equal(typeof ref, 'string', label);
      if (ref.startsWith('./')) {
        const local = await realpath(join(root, ref));
        assert.ok(local.startsWith(root + sep), 'local action must stay inside repository');
        const target = jobs.includes(entry) ? local
          : join(local, (await readdir(local)).includes('action.yml') ? 'action.yml' : 'action.yaml');
        await inspect(target);
      } else if (ref.startsWith('docker://')) {
        assert.match(ref, /^docker:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/, `${label} must use an immutable digest`);
      } else {
        const [action, sha] = ref.split('@');
        assert.match(ref, /^[^@\s]+@[a-f0-9]{40}$/, `${label} must use an immutable commit`);
        assert.ok(manifest.actions[action], `${label} has no recorded provenance`);
        check(action, sha, label);
      }
    }
  };
  const directory = join(root, '.github/workflows');
  const names = (await readdir(directory)).filter(name => /\.ya?ml$/.test(name)).sort();
  assert.ok(names.length, 'no workflows were checked');
  for (const name of names) await inspect(join(directory, name));
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

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('dependency update policy separates review lanes and forbids updater merge authority', async () => {
  const config = JSON.parse(await readFile(new URL('renovate.json', root), 'utf8'));
  assert.deepEqual(config.enabledManagers, ['npm', 'pip_requirements', 'github-actions']);
  assert.deepEqual(config.schedule, ['before 6am on monday']);
  assert.equal(config.timezone, 'America/Chicago');
  assert.equal(config.automerge, false);
  assert.equal(config.platformAutomerge, false);
  assert.equal(config.separateMinorPatch, true);
  assert.deepEqual(config.labels, ['dependencies']);
  const lane = type => config.packageRules.find(rule => rule.matchUpdateTypes?.includes(type));
  assert.equal(lane('patch').groupName, 'patch dependencies');
  assert.deepEqual(lane('patch').addLabels, ['dependency-patch']);
  assert.equal(lane('minor').groupName, 'minor dependencies');
  assert.deepEqual(lane('minor').addLabels, ['dependency-minor']);
  assert.equal(lane('major').groupName, undefined);
  assert.deepEqual(lane('major').addLabels, ['dependency-major']);
  assert.ok(config.packageRules.some(rule => rule.matchManagers?.includes('github-actions') && rule.pinDigests === true));
  const actionPins = config.packageRules.find(rule => rule.matchManagers?.includes('github-actions') && rule.matchUpdateTypes?.includes('digest'));
  assert.deepEqual(actionPins.matchUpdateTypes, ['pin', 'digest']);
  assert.deepEqual(actionPins.addLabels, ['dependency-patch']);
  assert.equal(config.vulnerabilityAlerts.enabled, true);
  assert.deepEqual(config.vulnerabilityAlerts.schedule, []);
  assert.equal(config.vulnerabilityAlerts.groupName, null);
  assert.deepEqual(config.vulnerabilityAlerts.addLabels, ['dependency-security']);
  assert.equal(config.vulnerabilityAlerts.automerge, false);
  assert.equal(config.vulnerabilityAlerts.platformAutomerge, false);
  for (const scope of [config, ...config.packageRules, config.vulnerabilityAlerts]) {
    assert.ok(![...(scope.labels ?? []), ...(scope.addLabels ?? [])].includes('dependency-queue'), 'the updater cannot bypass queue admission checks');
  }
  const githubFiles = await readdir(new URL('.github/', root));
  assert.ok(!githubFiles.includes('dependabot.yml') && !githubFiles.includes('dependabot.yaml'), 'only one updater may own active configuration');
});

test('Renovate can discover immutable action refs without losing release provenance', async () => {
  const pins = JSON.parse(await readFile(new URL('.github/action-pins.json', root), 'utf8'));
  const workflows = await readdir(new URL('.github/workflows/', root));
  for (const file of workflows) {
    const text = await readFile(new URL(`.github/workflows/${file}`, root), 'utf8');
    for (const [, action, sha, version] of text.matchAll(/uses: ([\w-]+\/[\w-]+)@([^\s]+)([^\n]*)/g)) {
      assert.match(sha, /^[a-f0-9]{40}$/);
      assert.ok(version.includes(`# ${pins.actions[action].tag}`), `${file}: ${action} needs its verified version comment for Renovate discovery`);
      assert.equal(sha, pins.actions[action].canonical_tag_sha);
    }
  }
});

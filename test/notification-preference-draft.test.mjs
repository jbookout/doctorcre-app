import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createFixtureClient } from "../js/fixture-client.js";
import { preferenceView, setPreferenceArgs } from "../js/notifications-model.js";
import { preferenceSaveView } from "../js/notification-preference-draft.mjs";

const fixture = async () => {
  const seed = await readFile(new URL("../data/board-seed.json", import.meta.url));
  return createFixtureClient({ seedUrl: `data:application/json;base64,${seed.toString("base64")}` });
};

test("an edited preference keeps its original version across a resume read", async () => {
  const client = await fixture();
  const first = await client.notificationPreferences();
  const editedVersion = first.version;

  // Another tab changes the store before this tab resumes and refreshes.
  await client.setNotificationPreference({
    idempotency_key: "pref-draft-other-tab", base_version: first.version,
    device_opt_in: true,
  });
  const refreshed = await client.notificationPreferences();
  assert.equal(refreshed.version, editedVersion + 1);

  // The former page used refreshed directly: its request would carry version
  // 2 and bypass the conflict, even though the fields were typed at version 1.
  const former = setPreferenceArgs({ device_opt_in: false }, preferenceView(refreshed));
  assert.equal(former.args.base_version, refreshed.version);

  const built = setPreferenceArgs(
    { device_opt_in: false },
    preferenceSaveView(preferenceView(refreshed), editedVersion),
  );
  assert.equal(built.args.base_version, editedVersion);
  await assert.rejects(
    () => client.setNotificationPreference({ idempotency_key: "pref-draft-stale-tab", ...built.args }),
    (error) => error.payload?.error === "version_conflict",
  );
  assert.equal((await client.notificationPreferences()).device_opt_in, true);
});

test("an untouched form saves against the most recent read", async () => {
  const client = await fixture();
  const first = await client.notificationPreferences();
  await client.setNotificationPreference({
    idempotency_key: "pref-draft-refresh", base_version: first.version,
    device_opt_in: true,
  });
  const refreshed = await client.notificationPreferences();
  const built = setPreferenceArgs(
    { device_opt_in: false },
    preferenceSaveView(preferenceView(refreshed), null),
  );
  assert.equal(built.args.base_version, refreshed.version);
  const saved = await client.setNotificationPreference({ idempotency_key: "pref-draft-fresh-tab", ...built.args });
  assert.equal(saved.device_opt_in, false);
});

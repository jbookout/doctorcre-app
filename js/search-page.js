import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs } from "./shell.js";
import { mountSearch } from "./search.js";

async function boot() {
  mountPrefs();

  const resolved = resolveDealroomBoot(globalThis.location);
  const client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  mountNotificationBadge(client);
  mountSearch({ client });
}

boot();

import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountCharts } from "./charts.js";

async function boot() {
  const resolved = resolveDealroomBoot(globalThis.location);
  const client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  mountCharts({ client });
}

boot().catch((error) => {
  const state = document.getElementById("chartsState");
  state.hidden = false;
  state.textContent = `Charts could not open: ${error.message}`;
});

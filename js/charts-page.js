import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { createLeadBoardClient } from './leads-client.js';
import { mountIdealClientProfile } from './ui-ideal-client-profile.generated.js';
import { mountCharts } from "./charts.js";

async function boot() {
  const resolved = resolveDealroomBoot(globalThis.location);
  const client = resolved.mode === "live" ? createLiveClient() : await (await import("./fixture-client.js")).createFixtureClient(resolved.options);
  mountCharts({ client });
  const host = document.getElementById('historicalClientFit');
  if (host) mountIdealClientProfile(host, resolved.mode === 'live' ? createLeadBoardClient() : {
    getIdealClientProfile: async () => ({ schema_version: 'ideal-client-profile.v1', coverage: 'recorded_closed_won_only', profiles: [] }),
  });
}

boot().catch((error) => {
  const state = document.getElementById("chartsState");
  state.hidden = false;
  state.textContent = `Charts could not open: ${error.message}`;
});

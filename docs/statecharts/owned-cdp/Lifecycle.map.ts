export const regions = ["acquisition", "result"];
const labels: Record<string, string> = {
  ProcessStarted: "process started",
  EndpointReceived: "endpoint received",
  HandshakeSucceeds: "handshake succeeds",
  AcquisitionFails: "acquisition fails",
  OwnerCloses: "owner closes",
  ProcessExits: "process exits",
  ResourcesDisposed: "resources disposed",
};
const states: Record<string, string> = {
  Starting: "Starting Chromium",
  AwaitingEndpoint: "Waiting for browser address",
  Connecting: "Connecting to Chromium",
  Ready: "Browser available",
  Closing: "Disposing browser",
  Closed: "Browser disposed",
  Pending: "No fixture returned",
  Returned: "Fixture returned",
  Retired: "Fixture retired",
  Refused: "Acquisition refused",
};
export const readerActions = ["OwnerCloses"];
export const state = (value: Record<string, string>) =>
  regions.map((region) => states[value[region] || ""] || value[region]).join(" | ");
export const step = (action: string) => labels[action] || action;

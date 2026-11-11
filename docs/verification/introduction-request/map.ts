type State = { s: { phase: string } };
const labels: Record<string, string> = {
  selected: "Offered path selected",
  reviewing: "Reviewing the introduction",
  submitting: "Recording the request",
  refused: "Request refused",
  unknown: "Outcome unknown",
  confirmed: "Request recorded",
  changed_source: "Review needs refresh",
  retired: "Session ended",
};
const steps: Record<string, string> = {
  Open: "Open offered path",
  OpenUnavailable: "Offered path unavailable",
  Review: "Review these people",
  Prepare: "Record requested introduction",
  Validate: "Verify current offered path",
  InvalidSource: "Source cannot be verified",
  Send: "Send the reviewed request",
  Refuse: "Server refuses",
  LoseResponse: "Response or readback unavailable",
  Receipt: "Server returns a receipt",
  MatchingReadback: "Exact canonical request matches",
  Recover: "Check the same request",
  SourceChanges: "Source freshness changes",
  PreflightSessionRefusal: "Session refusal clears the review",
  Retire: "Session ends",
};
export const readerActions = ["Open", "OpenUnavailable", "Review", "Prepare", "Recover", "Retire"];
export const state = (value: State) => labels[value.s.phase] || value.s.phase;
export const step = (action: string) => steps[action] || action;

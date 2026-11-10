export const regions = ["request", "session"];
const LABELS: Record<string, string> = {
  ServerConfirmsRead: "Server confirms read",
  ReadFailsValidationOrConnection: "Read fails validation or connection",
  RetryRead: "Retry read",
  RefreshWatch: "Refresh watch",
  SubmitCommand: "Submit command",
  ServerConfirmsCommand: "Server confirms command",
  ResponseLostOrMalformed: "Response lost or malformed",
  RetryIdenticalCommandAndKey: "Retry identical command and key",
  StaleVersionFetchesCurrentState: "Stale version fetches current state",
  IgnoreLateReply: "Ignore late reply",
  SignOut: "Sign out",
};

export const readerActions = ["SubmitCommand", "RetryIdenticalCommandAndKey", "RetryRead", "RefreshWatch", "SignOut"];
export const state = (v: Record<string, string>) => regions.map((r) => v[r]).join(" | ");
export const step = (action: string) => LABELS[action] ?? action;

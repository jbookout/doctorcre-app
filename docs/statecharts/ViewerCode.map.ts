const screens: Record<string, string> = {
  Closed: "Closed",
  Loading: "Loading text",
  Ready: "Reading text",
  Unavailable: "Text unavailable",
  NoText: "No text layer",
  SourceChanged: "Original changed",
  Expired: "Session ended",
};
const requests: Record<string, string> = {
  Empty: "No retained text",
  Pending: "Waiting for current read",
  Current: "Current document text",
  Retired: "Text cleared",
};
const actions: Record<string, string> = {
  Open: "Open text",
  Produced: "Text arrives",
  Failed: "Read fails",
  NoTextFound: "No readable text",
  Changed: "Original changed",
  Navigate: "Read page or next chunk",
  Retry: "Retry read",
  Close: "Close text",
  Switch: "Open another document",
  Retire: "Session ends",
  Late: "Old result arrives",
};
// Render every edge because late stuttering completions keep all screens formally unsettled.
export const readerActions: string[] = [];
export const state = (value: Record<string, string>) =>
  `${screens[value.lifecycle ?? ""]} | ${requests[value.requestIdentity ?? ""]}`;
export const step = (action: string) => actions[action] ?? action;

export type Brief = { sponsor: "joe" | "dell"; sections: Record<string, unknown> };
export type BriefView = {
  sponsor: "joe" | "dell";
  day: string;
  groups: { key: string; label: string; row: { key: string; title: string; due: string | null } }[];
  unavailable: string[];
  coverage: { key: string }[];
  observedAt: string;
};
export function normalizeBrief(payload: unknown): Brief | null;
export function morningBriefView(
  payload: Brief,
  options?: { now?: Date; since?: string; events?: unknown[]; caughtUp?: boolean; owner?: string },
): BriefView | null;

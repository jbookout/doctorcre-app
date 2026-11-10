export function validateLeadWorkspace<T>(payload: T): T;
export function validateLeadDetail<T>(detail: T, id: string): T;
export type QuietProposal = {
  subject_type: string;
  subject_id: string;
  ref: string;
  name: string;
  basis: "created_at" | "last_contact";
  anchor_on: string;
  due_on: string;
  days_overdue: number;
  owner?: string | null;
};
export function validateQuietFollowUps(payload: unknown): { proposals: QuietProposal[] };

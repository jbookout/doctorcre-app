type Node = {
  id: string;
  record_id: string;
  name: string;
  ref?: string;
  kind: string;
  territory: string;
  verticals: string[];
  owner: string;
  summary: string;
  contact_state: string;
  restricted?: boolean;
};
type Edge = {
  id: string;
  from: string;
  to: string;
  via: string | null;
  kind: string;
  summary: string;
  detail: string;
  when: string;
};
type Suggestion = Pick<Edge, "id" | "from" | "to" | "via" | "detail" | "when"> & { reason: string };
export function relationshipNetworkFixture(now?: string): {
  schema: string;
  observed_at: string;
  valid_until: string;
  nodes: Node[];
  edges: Edge[];
  referrals: { node_id: string; deals: number; won: number; lost: number; win_rate: number | null }[];
  suggestions: Suggestion[];
};

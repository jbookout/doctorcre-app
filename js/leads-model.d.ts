export function visibleLeads<T extends { id: string }>(leads: T[], filters?: Record<string, string>): T[];
export function marketCounts<T extends { id: string }>(
  leads: T[],
  filters?: Record<string, string>,
  locate?: (lead: T) => { id: string } | null,
): { unlocatedIds: string[]; locations: { leadIds: string[] }[] }[];

export function leadTitle(lead: object): string;

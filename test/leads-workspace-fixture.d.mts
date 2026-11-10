export function workspace(): { leads: { id: string }[]; detail?: unknown };
export function detail(lead: { id: string } | undefined): unknown;

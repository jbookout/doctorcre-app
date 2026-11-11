export function workspace(): { leads: { id: string }[]; detail?: unknown };
export function detail(lead: { id: string } | undefined): unknown;

export function lead(n: number, fields?: Record<string, unknown>): { id: string };
export function emptyQuietFollowUps(): unknown;

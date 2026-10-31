export const MAX_READ_PAGES: number;
export function createPageBudget(options?: { document?: Pick<Document, 'visibilityState'>; now?: () => number }): () => number;

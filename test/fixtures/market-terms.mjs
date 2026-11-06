import { readFileSync } from 'node:fs';

export function marketTermsRecordings() {
  return JSON.parse(readFileSync(new URL('./market-terms/recordings.json', import.meta.url), 'utf8'));
}

export function marketTermsFixtures() {
  return Object.fromEntries(Object.entries(marketTermsRecordings().records).map(([name, record]) => [name, record.response]));
}

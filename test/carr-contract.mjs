import { readFile } from 'node:fs/promises';

const { schema, version } = JSON.parse(await readFile(
  new URL('../contracts/carr-interface.v1.json', import.meta.url), 'utf8'));

export const carrContractIdentity = { schema, version };

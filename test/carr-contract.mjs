import { readCarrInterface } from '../scripts/carr-interface.mjs';

export const carrInterface = await readCarrInterface();
export const carrContractIdentity = { schema: carrInterface.schema, version: carrInterface.version };

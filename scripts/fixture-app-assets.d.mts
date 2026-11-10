export function appAssetSnapshot(
  builtRoot?: string,
  sourceRoot?: string,
): Promise<Map<string, { body: Buffer; contentType: string }>>;

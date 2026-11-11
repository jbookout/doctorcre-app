// Use the Workers Free ceiling without assuming the account's paid plan.
// https://developers.cloudflare.com/workers/platform/limits/#static-assets
const STATIC_ASSET_LIMIT = 20_000;
const MINIMUM_HEADROOM = 2_000;

export function assetBudget(payloadFiles: number) {
  if (!Number.isSafeInteger(payloadFiles) || payloadFiles < 0) throw Error("Invalid artifact file count");
  const deployedFiles = payloadFiles + 1; // artifact-manifest.json is also uploaded.
  const headroom = STATIC_ASSET_LIMIT - deployedFiles;
  if (headroom < MINIMUM_HEADROOM) {
    throw Error(`Static asset headroom ${headroom} is below required margin ${MINIMUM_HEADROOM}`);
  }
  return { deployedFiles, limit: STATIC_ASSET_LIMIT, headroom, minimumHeadroom: MINIMUM_HEADROOM };
}

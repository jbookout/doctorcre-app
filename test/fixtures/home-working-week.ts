import { appAssetSnapshot } from "../../scripts/fixture-app-assets.mjs";

export async function workingWeekAssets(
  day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
) {
  const assets = await appAssetSnapshot();
  const value = assets.get("/data/board-seed.json");
  if (!value) throw Error("Missing canonical fixture seed");
  const seed = JSON.parse(value.body.toString());
  for (const deal of seed.deals) {
    deal.next_date = deal.id === "d01" ? day : null;
    deal.next_step ||= "Synthetic dated deal work";
  }
  assets.set("/data/board-seed.json", { ...value, body: Buffer.from(JSON.stringify(seed)) });
  return assets;
}

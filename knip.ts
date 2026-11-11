import { existsSync } from "node:fs";
import config from "./scripts/knip-base.json" with { type: "json" };
import { UI_ENTRIES, UI_SOURCE } from "./scripts/ui-bundle.mjs";

const entries = Object.entries(UI_ENTRIES).map(([name, source]) => {
  const path = [`${UI_SOURCE}/${source}.tsx`, `${UI_SOURCE}/${source}.ts`].find(existsSync);
  if (!path) throw Error(`Missing UI bundle entry ${source}`);
  return { name, path };
});

export default {
  ...config,
  entry: [...config.entry, ...entries.map(({ path }) => path)],
  paths: {
    ...config.paths,
    ...Object.fromEntries(entries.map(({ name, path }) => [`/js/${name}.generated.js`, [path]])),
  },
};

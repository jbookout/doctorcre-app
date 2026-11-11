import { rmSync } from "node:fs";
import { join } from "node:path";

export const rawReadCorpus = [
  "readFile(/DevToolsActivePort/.source)",
  'import { launch as start } from "@puppeteer/browsers"; start(options)',
  'readFile("DevToolsActivePort")',
  'readFileSync(join(profile,"DevToolsActivePort"))',
  "const {readFile: read} = promises; read(`DevToolsActivePort`)",
  'const a="DevTools"; readFile(a+"ActivePort")',
  'readFile(`DevTools@{"Active"}Port`)'.replace("@", "$"),
  'export {cdpEndpoint as endpoint} from "./cdp-fixture.ts"',
  'import {cdpEndpoint as alias} from "./cdp-fixture.ts"',
  "launch({args:[`--remote-debugging-port=@{port}`]})".replace("@", "$"),
];

export function hideProfileMarker(profile: string): string {
  const marker = join(profile, "DevToolsActivePort");
  rmSync(marker, { force: true });
  return marker;
}

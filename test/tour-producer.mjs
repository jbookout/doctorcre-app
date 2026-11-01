import { stripTypeScriptTypes } from "node:module";

const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

export function committedTourWebModule(committed) {
  const timestamp = stripTypeScriptTypes(committed("mcp-server/src/tour-route-timestamp.ts"));
  const source = committed("mcp-server/src/tour-internal-web.js");
  const specifier = '"./tour-route-timestamp.ts"';
  if (!source.includes(specifier)) throw new Error("Pinned Tour web adapter does not import the expected timestamp module");
  return import(dataModule(source.replace(specifier, JSON.stringify(dataModule(timestamp)))));
}

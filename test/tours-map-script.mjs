// Existing Tours tests evaluate ES modules in an isolated DOM. Include the
// production map component and its pinned contract in that same harness.
import { readFile } from "node:fs/promises";
const read = path => readFile(new URL(path, import.meta.url), "utf8");
const canonical = (await read("../tours/vendor/tour-map-route-state.js")).replace(/^export /gm, "");
const component = (await read("../tours/itinerary-map.js")).replace(/^import [^\n]*\n/gm, "").replace(/^export /gm, "").replaceAll("import.meta.url", '"https://tour.test/tours/itinerary-map.js"');
const model = (await read("../js/doc-context-model.js")).replace(/^export /gm, "");
const context = (await read("../js/doc-context.js")).replace(/^import [^\n]*\n/gm, "").replace(/^export /gm, "");
export const mapScript = `const { observeDocRead, selectDocRecord } = (() => { ${model}; ${context}; return { observeDocRead, selectDocRecord }; })();
const { mountAcceptedItinerary, acceptedRouteFromDetail } = (() => {
  const { buildRouteVersionState, projectRoute, reduceMapEvent, buildNativeNavLink, buildReturnState, resolveReturn } = (() => { ${canonical}; return { buildRouteVersionState, projectRoute, reduceMapEvent, buildNativeNavLink, buildReturnState, resolveReturn }; })();
  ${component}; return { mountAcceptedItinerary, acceptedRouteFromDetail };
})();`;

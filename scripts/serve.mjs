import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const routes = JSON.parse(await readFile(new URL("../contracts/app-routes.v1.json", import.meta.url), "utf8")).routes;
const types = {".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".png":"image/png",".svg":"image/svg+xml",".webmanifest":"application/manifest+json; charset=utf-8"};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const requested = routes[url.pathname] || url.pathname.replace(/^\//, "");
    const path = resolve(root, requested || "workspace.html");
    const repositoryPath = relative(root, path);
    if (repositoryPath.startsWith("..") || isAbsolute(repositoryPath) || !(await stat(path)).isFile()) throw new Error("not found");
    response.writeHead(200, {"content-type": types[extname(path)] || "application/octet-stream", "cache-control":"no-store"});
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, {"content-type":"text/plain; charset=utf-8"});
    response.end("Not found\n");
  }
}).listen(8787, "127.0.0.1", () => console.log("DoctorCRE fixture server: http://127.0.0.1:8787"));

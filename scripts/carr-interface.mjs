// The CARR interface is a directory, one file per entry, so two branches that
// each add a verb, an HTTP surface or a contract section add different files
// and never edit the same lines:
//
//   <key>.json                  the value of top-level key <key>
//   mcp_operations/<verb>.json  one list entry, a JSON string
//   http_surfaces/<slug>.json   {value, order} preserves the contract array order
//   <key>/<name>.json           the value of <key>.<name> (mcp_read_contracts, ...)
//
// composeCarrInterface rebuilds the one object every consumer reads; its
// canonical text is what the artifact manifest digests.
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CARR_INTERFACE = "contracts/carr-interface.v1";
const LISTS = new Set(["mcp_operations", "http_surfaces"]);
/** The file name of a list entry: "/api/v1/x/{id}" is http_surfaces/api-v1-x-id.json. */
export const entryFileName = (entry) => `${entry.replace(/\*/g, "all").replace(/[{}]/g, "")
  .replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.json`;
const sorted = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function composeCarrInterface(files) {
  const top = new Map();
  const groups = new Map();
  for (const [path, text] of files) {
    const parts = path.split("/");
    const stem = (name) => {
      if (!name.endsWith(".json") || name === ".json") throw new Error(`${CARR_INTERFACE}/${path}: every entry is a .json file`);
      return name.slice(0, -5);
    };
    if (parts.length === 1) top.set(stem(parts[0]), JSON.parse(text));
    else if (parts.length === 2) {
      if (!groups.has(parts[0])) groups.set(parts[0], []);
      groups.get(parts[0]).push([stem(parts[1]), JSON.parse(text), path]);
    } else throw new Error(`${CARR_INTERFACE}/${path}: entries nest one directory deep at most`);
  }
  for (const [key, entries] of groups) {
    if (top.has(key)) throw new Error(`${CARR_INTERFACE}: ${key} is both a file and a directory`);
    if (!LISTS.has(key)) { top.set(key, sorted(entries)); continue; }
    if (key === "http_surfaces") entries.sort(([, a], [, b]) => a.order - b.order || String(a.value).localeCompare(String(b.value), "en"));
    const values = entries.map(([, entry, path]) => {
      if (key === "http_surfaces" && (!Number.isSafeInteger(entry?.order) || entry.order < 0)) {
        throw new Error(`${CARR_INTERFACE}/${path}: a surface needs a nonnegative integer order`);
      }
      const value = key === "http_surfaces" ? entry.value : entry;
      if (typeof value !== "string") throw new Error(`${CARR_INTERFACE}/${path}: a ${key} entry is a JSON string`);
      if (path !== `${key}/${entryFileName(value)}`) throw new Error(`${CARR_INTERFACE}/${path}: name it ${entryFileName(value)}`);
      return value;
    });
    if (new Set(values).size !== values.length) throw new Error(`${CARR_INTERFACE}/${key}: duplicate entry`);
    top.set(key, key === "http_surfaces" ? values : values.sort());
  }
  return sorted(top);
}

export const carrInterfaceText = (contract) => `${JSON.stringify(contract, null, 2)}\n`;

export async function readCarrInterface(root = new URL("../", import.meta.url)) {
  const directory = join(fileURLToPath(root), CARR_INTERFACE);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push([relative(directory, path).split(sep).join("/"), await readFile(path, "utf8")]);
  }
  return composeCarrInterface(files);
}

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const ROOT_FILES = [
  "business.html", "design-business.html", "design-operations.html", "design.html",
  "index.html", "leads.html", "manifest.webmanifest",
  "queue.html", "room.html", "system-work.html", "tasks.html", "work-inventory.html", "workspace.html",
];
const ROOT_DIRECTORIES = ["css", "data", "js", "public-shell", "reports", "tours"];
const SHA = /^[0-9a-f]{64}$/;

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function walk(root, directory) {
  const paths = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`artifact input must be a regular file: ${path}`);
  }
  return paths;
}

function sourceCommit(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function field(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function octal(value, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`tar number is too large: ${value}`);
  return `${encoded}\0`;
}

function tarHeader(path, size) {
  const header = Buffer.alloc(512);
  field(header, 0, 100, path);
  field(header, 100, 8, octal(0o644, 8));
  field(header, 108, 8, octal(0, 8));
  field(header, 116, 8, octal(0, 8));
  field(header, 124, 12, octal(size, 12));
  field(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  field(header, 156, 1, "0");
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  field(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tar(entries) {
  const chunks = [];
  for (const { path, content } of entries) {
    chunks.push(tarHeader(path, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function parseTar(archive) {
  if (archive.length < 1024 || archive.length % 512 !== 0) throw new Error("invalid artifact archive length");
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const trailer = archive.subarray(offset);
      if (trailer.length < 1024 || !trailer.every((byte) => byte === 0)) throw new Error("invalid artifact archive trailer");
      return entries;
    }
    const storedChecksum = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const calculatedChecksum = [...checksumHeader].reduce((sum, byte) => sum + byte, 0);
    if (!Number.isSafeInteger(storedChecksum) || storedChecksum !== calculatedChecksum) throw new Error("invalid artifact header checksum");
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    if (!path || path.startsWith("/") || path.split("/").includes("..") || type !== "0") throw new Error(`unsafe artifact entry: ${path}`);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error(`invalid artifact entry size: ${path}`);
    if (entries.has(path)) throw new Error(`duplicate artifact entry: ${path}`);
    entries.set(path, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("artifact archive trailer is missing");
}

export async function buildArtifact({ root, outDir, commit = sourceCommit(root) }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("source commit must be a full Git SHA");
  const paths = [...ROOT_FILES];
  for (const directory of ROOT_DIRECTORIES) paths.push(...await walk(root, directory));
  paths.sort();

  const payload = [];
  const files = new Map();
  const siteDir = join(outDir, "site");
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  for (const path of paths) {
    const sourcePath = join(root, ...path.split("/"));
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error(`artifact input is not a file: ${path}`);
    const content = await readFile(sourcePath);
    files.set(path, content);
    const deploymentPath = join(siteDir, ...path.split("/"));
    await mkdir(dirname(deploymentPath), { recursive: true });
    await writeFile(deploymentPath, content);
    payload.push({ path, bytes: content.length, sha256: digest(content) });
  }

  const contract = async (path) => {
    const content = await readFile(join(root, path));
    const parsed = JSON.parse(content);
    return { path, schema: parsed.schema, version: parsed.version, sha256: digest(content) };
  };
  const manifest = {
    schema: "doctorcre-static-artifact.v1",
    repository: "jbookout/doctorcre-app",
    source_commit: commit,
    entrypoint: "workspace.html",
    carr_interface: await contract("contracts/carr-interface.v1.json"),
    route_contract: await contract("contracts/app-routes.v1.json"),
    files: payload,
  };
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries = [{ path: "artifact-manifest.json", content: manifestContent }];
  for (const path of paths) entries.push({ path, content: files.get(path) });
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const archive = tar(entries);
  const archiveSha256 = digest(archive);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "doctorcre-app.tar"), archive);
  await writeFile(join(outDir, "doctorcre-app.manifest.json"), manifestContent);
  await writeFile(join(outDir, "doctorcre-app.tar.sha256"), `${archiveSha256}  doctorcre-app.tar\n`);
  return { archive, archiveSha256, manifest };
}

export function verifyArtifact(archive, expectedSha256 = null) {
  const archiveSha256 = digest(archive);
  if (expectedSha256 && archiveSha256 !== expectedSha256) throw new Error("artifact archive digest mismatch");
  const entries = parseTar(archive);
  const manifestContent = entries.get("artifact-manifest.json");
  if (!manifestContent) throw new Error("artifact manifest is missing");
  const manifest = JSON.parse(manifestContent);
  if (manifest.schema !== "doctorcre-static-artifact.v1" || !/^[0-9a-f]{40}$/.test(manifest.source_commit)) throw new Error("artifact manifest identity is invalid");
  if (!Array.isArray(manifest.files) || manifest.files.length + 1 !== entries.size) throw new Error("artifact manifest file set is incomplete");
  const manifestPaths = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || file.path === "artifact-manifest.json" || file.path.startsWith("/") || file.path.split("/").includes("..") || !SHA.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error("artifact manifest file row is invalid");
    if (manifestPaths.has(file.path)) throw new Error(`duplicate artifact manifest path: ${file.path}`);
    manifestPaths.add(file.path);
    const content = entries.get(file.path);
    if (!content || content.length !== file.bytes || digest(content) !== file.sha256) throw new Error(`artifact payload mismatch: ${file.path}`);
  }
  return { archiveSha256, manifest, fileCount: manifest.files.length };
}

export async function runCli(root, args = process.argv.slice(2)) {
  const outDir = join(root, "dist");
  const command = args[0] || "build";
  if (command === "build") {
    const result = await buildArtifact({ root, outDir, commit: process.env.DOCTORCRE_SOURCE_COMMIT || sourceCommit(root) });
    console.log(`built doctorcre-app.tar: ${result.manifest.files.length} files, sha256:${result.archiveSha256}`);
    return;
  }
  if (command === "verify") {
    const archive = await readFile(join(outDir, "doctorcre-app.tar"));
    const sidecar = (await readFile(join(outDir, "doctorcre-app.tar.sha256"), "utf8")).trim().split(/\s+/)[0];
    const result = verifyArtifact(archive, sidecar);
    console.log(`verified doctorcre-app.tar: ${result.fileCount} files, sha256:${result.archiveSha256}`);
    return;
  }
  throw new Error(`unknown artifact command: ${command}`);
}

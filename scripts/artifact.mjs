import { GENERATED_PATHS, prepareSlices, sliceNames, sliceOutputs } from "./slices.mjs";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const ROOT_FILES = ["manifest.webmanifest"];
const ROOT_DIRECTORIES = ["css", "data", "js", "public-shell", "reports", "tours"];
const CONTRACT_INPUTS = {
  carr_interface: "contracts/carr-interface.v1.json",
  route_contract: "contracts/app-routes.v1.json",
};
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

async function inputPaths(root, sliceRegistration) {
  const sliceAssets = sliceRegistration.slices.flatMap(slice => slice.files || []).filter(path => !path.startsWith('test/'));
  const paths = [...ROOT_FILES, ...sliceAssets];
  for (const directory of ROOT_DIRECTORIES) {
    if (!(await lstat(join(root, directory))).isDirectory()) throw new Error(`artifact input must be a directory: ${directory}`);
    paths.push(...await walk(root, directory));
  }
  return [...new Set(paths)].sort();
}

async function assembleArtifact(commit, paths, readSource, sliceRegistration) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("source commit must be a full Git SHA");
  const payload = [];
  const files = new Map();
  for (const path of paths) {
    let content = await readSource(path);
    if (path === "reports/share.js") {
      // Compile the report's explicit module graph from the same admitted bytes
      // used by assembly and committed-source verification, never the live disk.
      const result = await build({
        entryPoints: [path], bundle: true, write: false, format: "iife",
        platform: "browser", target: "es2022", legalComments: "none",
        plugins: [{ name: "artifact-source", setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            // The report adapter already serves lazy map assets at /vendor/.
            if (args.kind === "dynamic-import" && args.path.startsWith("/vendor/") && paths.includes(`reports${args.path}`)) {
              return { path: args.path, external: true };
            }
            const resolved = args.kind === "entry-point" ? posix.normalize(args.path)
              : posix.normalize(posix.join(posix.dirname(args.importer), args.path));
            if ((args.kind !== "entry-point" && !args.path.startsWith(".")) || !paths.includes(resolved)) {
              throw new Error(`report import is not an admitted artifact input: ${args.path}`);
            }
            return { path: resolved, namespace: "artifact-source" };
          });
          builder.onLoad({ filter: /.*/, namespace: "artifact-source" }, async (args) => ({
            contents: (await readSource(args.path)).toString("utf8"), loader: "js",
          }));
        } }],
      });
      content = Buffer.from(result.outputFiles[0].contents);
    }
    if (path === "reports/share.css") {
      const shell = await readSource("css/app-shell.css");
      content = Buffer.concat([content, Buffer.from("\n"), shell]);
    }
    files.set(path, content);
    payload.push({ path, bytes: content.length, sha256: digest(content) });
  }

  const contract = async (path) => {
    const content = await readSource(path);
    const parsed = JSON.parse(content);
    return { path, schema: parsed.schema, version: parsed.version, sha256: digest(content) };
  };
  const contracts = {};
  for (const [key, path] of Object.entries(CONTRACT_INPUTS)) contracts[key] = await contract(path);
  const manifest = {
    schema: "doctorcre-static-artifact.v1",
    repository: "jbookout/doctorcre-app",
    source_commit: commit,
    entrypoint: "workspace.html",
    ...contracts,
    files: payload,
  };
  const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries = [{ path: "artifact-manifest.json", content: manifestContent }];
  for (const path of paths) entries.push({ path, content: files.get(path) });
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const archive = tar(entries);
  const archiveSha256 = digest(archive);
  return { archive, archiveSha256, manifest, manifestContent, files };
}

export async function buildArtifact({ root, outDir, commit = sourceCommit(root) }) {
  const sliceRegistration = await prepareSlices(root);
  const paths = await inputPaths(root, sliceRegistration);
  const readSource = async (path) => {
    const sourcePath = join(root, path);
    if (!(await lstat(sourcePath)).isFile()) throw new Error(`artifact input is not a file: ${path}`);
    return readFile(sourcePath);
  };
  const { archive, archiveSha256, manifest, manifestContent, files } = await assembleArtifact(commit, paths, readSource, sliceRegistration);
  const siteDir = join(outDir, "site");
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  for (const [path, content] of files) {
    const deploymentPath = join(siteDir, path);
    await mkdir(dirname(deploymentPath), { recursive: true });
    await writeFile(deploymentPath, content);
  }
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

export async function verifyCommittedSource(root, archive, result = verifyArtifact(archive)) {
  const commit = sourceCommit(root);
  if (result.manifest.source_commit !== commit) throw new Error("artifact source commit mismatch");
  const names = await sliceNames(root);
  const onDiskRegistration = await sliceOutputs(names, path => readFile(join(root, path)));
  const paths = await inputPaths(root, onDiskRegistration);
  const contractPaths = Object.values(CONTRACT_INPUTS);
  const slicePaths = ['contracts/routes.v1.json', 'contracts/slice-ownership.v1.json', ...names.map(name => `contracts/routes/${name}.json`)];
  const sourcePaths = [...new Set([...paths, ...contractPaths, ...slicePaths])].filter(path => !GENERATED_PATHS.includes(path)).sort();
  const committedPaths = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit, "--",
    ...ROOT_FILES, ...ROOT_DIRECTORIES, ...contractPaths, ...slicePaths, ...paths], { cwd: root, encoding: "utf8" }).split("\0").filter(path => path && !GENERATED_PATHS.includes(path)).sort();
  if (JSON.stringify(sourcePaths) !== JSON.stringify(committedPaths)) throw new Error("artifact source input set mismatch");

  // Compare the bytes themselves, not Git's working-tree status/cache. A forged
  // archive and sidecars can agree internally while disagreeing with the commit.
  const source = new Map();
  for (const path of sourcePaths) {
    const committed = execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const sourcePath = join(root, path);
    if (!(await lstat(sourcePath)).isFile() || !(await readFile(sourcePath)).equals(committed)) {
      throw new Error(`artifact source input mismatch: ${path}`);
    }
    source.set(path, committed);
  }
  const sliceRegistration = await sliceOutputs(names, async path => source.get(path));
  for (const [path, bytes] of sliceRegistration.outputs) {
    if (!(await readFile(join(root, path))).equals(bytes)) throw new Error(`artifact source input mismatch: ${path}`);
    source.set(path, bytes);
  }
  const expected = await assembleArtifact(commit, paths, async (path) => source.get(path), sliceRegistration);
  if (!archive.equals(expected.archive)) throw new Error("artifact does not match committed source");
  return expected;
}

export async function runCli(root, args = process.argv.slice(2)) {
  const outDir = join(root, "dist");
  const command = args[0] || "build";
  if (command === "build") {
    const result = await buildArtifact({ root, outDir, commit: process.env.DOCTORCRE_SOURCE_COMMIT || sourceCommit(root) });
    console.log(`built doctorcre-app.tar: ${result.manifest.files.length} files, sha256:${result.archiveSha256}`);
    return;
  }
  if (command === "verify" || command === "prepare-deployment") {
    if (!(await lstat(outDir)).isDirectory()) throw new Error("artifact output must be a directory, never a symlink");
    for (const name of ["doctorcre-app.tar", "doctorcre-app.tar.sha256", "doctorcre-app.manifest.json"]) {
      if (!(await lstat(join(outDir, name))).isFile()) throw new Error("artifact handoff must contain regular files");
    }
    const archive = await readFile(join(outDir, "doctorcre-app.tar"));
    const sidecar = await readFile(join(outDir, "doctorcre-app.tar.sha256"), "utf8");
    const match = sidecar.match(/^([0-9a-f]{64})  doctorcre-app\.tar\n?$/);
    if (!match) throw new Error("artifact digest sidecar is invalid");
    const result = verifyArtifact(archive, match[1]);
    const expected = await verifyCommittedSource(root, archive, result);
    if (!(await readFile(join(outDir, "doctorcre-app.manifest.json"))).equals(expected.manifestContent)) {
      throw new Error("published manifest mismatch");
    }
    if (command === "prepare-deployment") {
      // Use the reconstructed, committed source bytes, never a restored dist/site.
      const siteDir = join(outDir, "site");
      await rm(siteDir, { recursive: true, force: true });
      for (const [path, bytes] of expected.files) {
        await mkdir(dirname(join(siteDir, path)), { recursive: true });
        await writeFile(join(siteDir, path), bytes);
      }
    }
    console.log(`verified doctorcre-app.tar: ${result.fileCount} files, sha256:${result.archiveSha256}`);
    return;
  }
  throw new Error(`unknown artifact command: ${command}`);
}

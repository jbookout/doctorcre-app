import { offlineTourShell } from "./offline-tour-shell.mjs";
import tarStream from "tar-stream";
import { Readable } from "node:stream";
import { UI_OUTPUT, UI_SOURCE, uiBundle } from "./ui-bundle.mjs";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const ROOT_FILES = ["manifest.webmanifest", "contracts/lease-radar.v1.json"];
const GENERATED_PATH = "tours/day-shell.generated.js";
const GENERATED_PATHS = [GENERATED_PATH, UI_OUTPUT];
const ROOT_DIRECTORIES = ["css", "data", "js", "public-shell", "reports", "tours"];
const CONTRACT_INPUTS = {
  carr_interface: "contracts/carr-interface.v1.json",
  route_contract: "js/routes.js",
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

async function tar(entries) {
  const pack = tarStream.pack();
  const chunks = [];
  const collecting = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const { path, content } of entries) {
    await new Promise((resolve, reject) => pack.entry({ name: path, size: content.length, type: "file", mode: 0o644, mtime: new Date(0) }, content, error => error ? reject(error) : resolve()));
  }
  pack.finalize();
  await collecting;
  return Buffer.concat(chunks);
}

async function parseTar(archive) {
  const entries = new Map();
  const extract = tarStream.extract();
  const input = Readable.from([archive]);
  input.pipe(extract);
  for await (const entry of extract) {
    const { name: path, type } = entry.header;
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || type !== "file") throw new Error(`unsafe artifact entry: ${path}`);
    if (entries.has(path)) throw new Error(`duplicate artifact entry: ${path}`);
    const chunks = [];
    for await (const chunk of entry) chunks.push(chunk);
    entries.set(path, Buffer.concat(chunks));
  }
  return entries;
}

async function inputPaths(root) {
  const pages = (await readdir(root)).filter(path => path.endsWith(".html"));
  const paths = [...ROOT_FILES, ...pages, ...GENERATED_PATHS];
  for (const directory of ROOT_DIRECTORIES) {
    if (!(await lstat(join(root, directory))).isDirectory()) throw new Error(`artifact input must be a directory: ${directory}`);
    paths.push(...await walk(root, directory));
  }
  return [...new Set(paths)].sort();
}

async function generatedShell(readSource) {
  const shell = await offlineTourShell(readSource);
  return Buffer.from(`self.TOUR_DAY_SHELL = ${JSON.stringify(shell)};\n`);
}

async function assembleArtifact(commit, paths, readSource) {
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
        platform: "browser", target: "es2022", legalComments: "none", minifyWhitespace: true,
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
      // The share page is served from a restricted asset set, so the V2 tokens and the
      // shared shell travel inside its one stylesheet: tokens first, shell last.
      // The shell's own @import of the tokens is dropped because the tokens are inlined here.
      const [tokens, shell] = await Promise.all([readSource("css/tokens.css"), readSource("css/app-shell.css")]);
      const inlinedShell = Buffer.from(shell.toString("utf8").replace('@import url("/css/tokens.css");\n', ""));
      content = Buffer.concat([tokens, Buffer.from("\n"), content, Buffer.from("\n"), inlinedShell]);
    }
    files.set(path, content);
    payload.push({ path, bytes: content.length, sha256: digest(content) });
  }

  const contract = async (path) => {
    const content = await readSource(path);
    const parsed = path.endsWith(".js")
      ? (await import(`data:text/javascript;base64,${content.toString("base64")}`)).routeContract
      : JSON.parse(content);
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
  const archive = await tar(entries);
  const archiveSha256 = digest(archive);
  return { archive, archiveSha256, manifest, manifestContent, files };
}

export async function buildArtifact({ root, outDir, commit = sourceCommit(root) }) {
  const shell = await generatedShell(path => readFile(join(root, path)));
  const ui = await uiBundle(path => readFile(join(root, path)));
  const paths = await inputPaths(root);
  const readSource = async (path) => {
    if (path === GENERATED_PATH) return shell;
    if (path === UI_OUTPUT) return ui;
    const sourcePath = join(root, path);
    if (!(await lstat(sourcePath)).isFile()) throw new Error(`artifact input is not a file: ${path}`);
    return readFile(sourcePath);
  };
  const { archive, archiveSha256, manifest, manifestContent, files } = await assembleArtifact(commit, paths, readSource);
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

export async function verifyArtifact(archive, expectedSha256 = null) {
  const archiveSha256 = digest(archive);
  if (expectedSha256 && archiveSha256 !== expectedSha256) throw new Error("artifact archive digest mismatch");
  const entries = await parseTar(archive);
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

export async function verifyCommittedSource(root, archive, result = null) {
  result ||= await verifyArtifact(archive);
  const commit = sourceCommit(root);
  if (result.manifest.source_commit !== commit) throw new Error("artifact source commit mismatch");
  const paths = await inputPaths(root);
  const contractPaths = Object.values(CONTRACT_INPUTS);
  const uiPaths = await walk(root, UI_SOURCE);
  const sourcePaths = [...new Set([...paths, ...contractPaths, ...uiPaths])].filter(path => !GENERATED_PATHS.includes(path)).sort();
  const committedPaths = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit],
    { cwd: root, encoding: "utf8" }).split("\0").filter(path => path && !GENERATED_PATHS.includes(path) && (
      ROOT_FILES.includes(path) || contractPaths.includes(path) || path.startsWith(UI_SOURCE + "/") || ROOT_DIRECTORIES.some(directory => path.startsWith(directory + "/"))
      || (!path.includes("/") && path.endsWith(".html"))
    )).sort();
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
  const shell = await generatedShell(async path => source.get(path));
  source.set(GENERATED_PATH, shell);
  source.set(UI_OUTPUT, await uiBundle(async path => source.get(path)));
  const expected = await assembleArtifact(commit, paths, async (path) => source.get(path));
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
    const result = await verifyArtifact(archive, match[1]);
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

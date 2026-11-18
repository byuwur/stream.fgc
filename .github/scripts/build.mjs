/**
 * @file Package the native controller and tracked runtime folders with clean starter data.
 * Run npm --prefix .github ci, then node .github/scripts/build.mjs --tag v0.0.0-local.
 * --binary adds a freshly built Stream.FGC Windows executable; without it, build the runtime ZIP.
 * Runtime libraries remain independent of this private build toolchain.
 */
import { zipSync } from "fflate";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { config, dist, finishBuild, git, releaseChangelog, root, sha256, validateTag } from "./release.mjs";

/**
 * Build Stream.FGC runtime/Windows ZIPs from explicit tracked paths and the starter template.
 * @param {string} tag Valid release or preview version.
 * @param {Object} [options={}] Optional binary path.
 * @returns {Promise<void>} Writes only dist build outputs.
 */
export async function buildRelease(tag, options = {}) {
  validateTag(tag);
  const changelog = releaseChangelog(tag);
  const manifest = { generator: `${config.repository} release builder`, repository: config.repository, tag, changelog, assets: [], packages: [] };
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  const selected = tracked.filter((file) => config.files.includes(file) || config.directories.some((directory) => file.startsWith(`${directory}/`)));
  assert.ok(selected.length > 2, "No runtime files found");
  const regular = {};
  for (const file of selected.sort()) {
    assert.ok(tracked.includes(file), `Only tracked runtime files may be packaged: ${file}`);
    assert.ok(!file.split("/").some((part) => part === ".." || part === "node_modules" || part === ".git" || part === "vendor" || part === "__tests__"), `Unsafe runtime path: ${file}`);
    assert.ok(!(await fs.lstat(path.join(root, file))).isSymbolicLink(), `Symlinks cannot be packaged: ${file}`);
    const bytes = await fs.readFile(path.join(root, file));
    regular[file] = bytes;
  }
  regular["data/tournament.json"] = await fs.readFile(path.join(root, "templates/default.json"));
  regular["players/"] = Buffer.alloc(0);
  await fs.mkdir(dist, { recursive: true });
  const staging = await fs.mkdtemp(path.join(dist, ".release-"));
  try {
    /** @param {string} variant Package name. @param {Object} entries Relative filenames and bytes. @param {string} description Download explanation. @returns {Promise<void>} */
    async function archive(variant, entries, description) {
      const file = `${config.repository.split("/")[1]}${variant === "regular" ? "" : `.${variant}`}.zip`;
      const body = Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [new Uint8Array(bytes), { mtime: new Date(1980, 0, 1) }]])), { level: 9 }));
      await fs.writeFile(path.join(staging, file), body);
      manifest.assets.push({ file, bytes: body.length, sha256: sha256(body), description });
      manifest.packages.push({ file, variant, files: Object.entries(entries).map(([name, bytes]) => ({ file: name, bytes: bytes.length, sha256: sha256(bytes) })) });
    }
    await archive("runtime", regular, "Runtime folders and starter data");
    if (options.binary) {
      const binary = await fs.readFile(path.resolve(root, options.binary));
      assert.equal(binary.subarray(0, 2).toString(), "MZ", "Expected a Windows executable");
      const peOffset = binary.readUInt32LE(0x3c);
      assert.equal(binary.subarray(peOffset, peOffset + 4).toString(), "PE\0\0", "Expected a PE executable");
      assert.equal(binary.readUInt16LE(peOffset + 4), 0x8664, "Expected a Windows x64 executable");
      await archive("windows-x64", { ...regular, "stream.fgc.exe": binary }, "Windows x64 app and runtime");
    }
    await finishBuild(staging, manifest);
  } finally {
    assert.equal(path.dirname(staging), dist);
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { tag: { type: "string" }, binary: { type: "string" } } });
  await buildRelease(values.tag || process.env.RELEASE_TAG || "v0.0.0-local", values);
}

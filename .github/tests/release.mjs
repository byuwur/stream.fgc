/** @file Verify native archive contents, provenance, and clean starter state. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { config, dist, git, releaseNotes, root, sha256, validateTag } from "../scripts/release.mjs";

const directory = path.join(dist, "assets");
const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));

test("checksums cover the complete inventory and the exact source commit", async () => {
  assert.equal(manifest.changelog.commit, git("rev-parse", "HEAD"));
  const files = [...manifest.assets.map((asset) => asset.file), "manifest.json"].sort();
  const checksums = (await fs.readFile(path.join(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
  assert.deepEqual(checksums.map((line) => line.split("  ")[1]).sort(), files);
  assert.deepEqual((await fs.readdir(directory)).sort(), [...files, "SHA256SUMS"].sort());
  for (const line of checksums) {
    const [hash, file] = line.split("  ");
    assert.equal(sha256(await fs.readFile(path.join(directory, file))), hash);
  }
});

for (const archive of manifest.packages)
  test(`package ${archive.variant} preserves runtime contracts`, { timeout: 120000 }, async () => {
    const entries = unzipSync(await fs.readFile(path.join(directory, archive.file)));
    assert.deepEqual(Object.keys(entries).sort(), archive.files.map((file) => file.file).sort());
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "release-package-"));
    try {
      const extracted = path.join(temporary, "stream.fgc");
      for (const file of archive.files) {
        assert.ok(!file.file.startsWith("/") && !file.file.split("/").includes(".."));
        assert.equal(sha256(entries[file.file]), file.sha256);
        if (file.file.endsWith("/")) continue;
        const filename = file.file;
        const destination = path.join(extracted, filename);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, entries[file.file]);
        if (!file.file.startsWith("data/") && file.file !== "stream.fgc.exe") assert.equal(file.sha256, sha256(await fs.readFile(path.join(root, file.file))));
      }
      assert.equal(sha256(entries["data/tournament.json"]), sha256(await fs.readFile(path.join(root, "templates/default.json"))));
      assert.ok(!Object.keys(entries).some((name) => name.includes("integrations.json") || name.includes(".env")));
      assert.ok(entries["templates/double8.json"] && entries["overlays/scoreboard.html"]);
      if (archive.variant === "windows-x64") assert.equal(Buffer.from(entries["stream.fgc.exe"]).subarray(0, 2).toString(), "MZ");
    } catch (error) {
      if (error.stdout) console.error(error.stdout.toString());
      if (error.stderr) console.error(error.stderr.toString());
      throw error;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

test("release notes link short hashes, escape subjects, and display the actual tag", () => {
  const notes = releaseNotes({ ...manifest, changelog: { previousTag: "v1.0", ref: "v1.1", commits: [{ sha: "a".repeat(40), subject: "[Fix] Keep <markup> and *literal* text" }] } });
  assert.ok(notes.includes(`- ([aaaaaaa](https://github.com/${config.repository}/commit/${"a".repeat(40)})) \\[Fix\\] Keep \\<markup\\> and \\*literal\\* text`));
  assert.ok(notes.includes("/compare/v1.0...v1.1"));
  for (const tag of ["v1.0", "v1.0.1", "v1.0.1-rc.1"]) assert.equal(validateTag(tag), tag);
  for (const tag of ["main", "../v1.0", "v01.0", "v1.0-01"]) assert.throws(() => validateTag(tag));
});

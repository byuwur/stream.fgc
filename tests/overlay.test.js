"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const window = { jQuery: function () {} };
const source = fs.readFileSync(path.join(root, "overlays/js/overlay.js"), "utf8");
vm.runInNewContext(source, { window });
test("overlay shares backend participant provenance fixtures", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, "backend/testdata/participant-resolution.json")));
  for (const fixture of cases) {
    const match = window.StreamFGCOverlay.resolveMatch(fixture.state, { matches: { X: { p1: fixture.source } } }, {
      characters: {}, options: {}, nopic: "", gameKey: ""
    }, "X");
    assert.equal(match.player1.status, fixture.status, fixture.name);
    assert.equal(match.player1.player_id, fixture.player_id, fixture.name);
    if (fixture.status === "bye") assert.equal(match.player1.name, "BYE", fixture.name);
  }
});

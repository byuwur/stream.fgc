"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const window = { jQuery: function () {} };
// Expose closure functions only in the test context; production keeps its existing API.
const source = fs.readFileSync(path.join(root, "overlays/js/overlay.js"), "utf8").replace("global.StreamFGCOverlay = api;", "global.StreamFGCOverlay = { ...api, championFromBracket, renderChampion };");
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

test("champion requires a completed final", () => {
  const api = window.StreamFGCOverlay;
  const final = { group: "finals", definition: {}, order: 1, state: { winner: "1" }, player1: { id: "1" } };
  assert.equal(api.championFromBracket([final]).id, "1");
  assert.equal(api.championFromBracket([{ ...final, group: "winners" }]), null);
  assert.equal(api.championFromBracket([]), null);
});

test("champion rendering clears prior text when no decisive final exists", () => {
  const elements = new Map();
  /** Implements only the jQuery surface touched by the actual champion renderer. */
  function jquery(target) {
    if (typeof target === "function") return;
    if (typeof target === "object") return target;
    if (!elements.has(target)) {
      const attrs = {};
      const element = {
        value: "", is() { return Boolean(this.visible); }, each(fn) { fn.call(this); return this; },
        attr(key, value) { if (value === undefined) return attrs[key]; attrs[key] = value; return this; },
        text(value) { this.value = value; return this; }, data() { return this; },
        off() { return this; }, on() { return this; }, removeClass() { return this; },
        addClass() { return this; }, removeData() { return this; }, css() { return this; },
        one(event, fn) { fn(); return this; }, show() { this.visible = true; return this; }, hide() { this.visible = false; return this; }
      };
      elements.set(target, element);
    }
    return elements.get(target);
  }
  const renderWindow = { jQuery: jquery, clearTimeout() {}, setTimeout() { return 1; }, requestAnimationFrame(fn) { fn(); } };
  vm.runInNewContext(source, { window: renderWindow });
  renderWindow.StreamFGCOverlay.renderChampion({ champion: { name: "Old champion", portrait_url: "old.png" }, event: { name: "Event" }, nopic: "" });
  assert.equal(elements.get("[data-champion-name]").value, "Old champion");
  renderWindow.StreamFGCOverlay.renderChampion({ champion: null });
  assert.equal(elements.get("[data-champion-name]").value, "");
  assert.equal(elements.get("[data-champion-panel]").visible, false);
});

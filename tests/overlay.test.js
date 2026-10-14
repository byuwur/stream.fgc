"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const window = { jQuery: function () {} };
// Expose closure functions only in the test context; production keeps its existing API.
const source = fs.readFileSync(path.join(root, "overlays/js/overlay.js"), "utf8").replace("global.StreamFGCOverlay = api;", "global.StreamFGCOverlay = { ...api, bracketHTML, championFromBracket, renderChampion };");
vm.runInNewContext(source, { window });
test("overlay shares backend participant provenance fixtures", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, "backend/testdata/participant-resolution.json")));
  for (const fixture of cases) {
    const match = window.StreamFGCOverlay.resolveMatch(
      fixture.state,
      { matches: { X: { p1: fixture.source } } },
      {
        characters: {},
        options: {},
        nopic: "",
        gameKey: ""
      },
      "X"
    );
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
        value: "",
        is() {
          return Boolean(this.visible);
        },
        each(fn) {
          fn.call(this);
          return this;
        },
        attr(key, value) {
          if (value === undefined) return attrs[key];
          attrs[key] = value;
          return this;
        },
        text(value) {
          this.value = value;
          return this;
        },
        data() {
          return this;
        },
        off() {
          return this;
        },
        on() {
          return this;
        },
        removeClass() {
          return this;
        },
        addClass() {
          return this;
        },
        removeData() {
          return this;
        },
        css() {
          return this;
        },
        one(event, fn) {
          fn();
          return this;
        },
        show() {
          this.visible = true;
          return this;
        },
        hide() {
          this.visible = false;
          return this;
        }
      };
      elements.set(target, element);
    }
    return elements.get(target);
  }
  const renderWindow = {
    jQuery: jquery,
    clearTimeout() {},
    setTimeout() {
      return 1;
    },
    requestAnimationFrame(fn) {
      fn();
    }
  };
  vm.runInNewContext(source, { window: renderWindow });
  renderWindow.StreamFGCOverlay.renderChampion({ champion: { name: "Old champion", portrait_url: "old.png" }, event: { name: "Event" }, nopic: "" });
  assert.equal(elements.get("[data-champion-name]").value, "Old champion");
  renderWindow.StreamFGCOverlay.renderChampion({ champion: null });
  assert.equal(elements.get("[data-champion-name]").value, "");
  assert.equal(elements.get("[data-champion-panel]").visible, false);
});

test("shared final fixtures distinguish decisive wins, resets, and stale history", () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(root, "backend/testdata/finals.json")));
  const template = JSON.parse(fs.readFileSync(path.join(root, "templates/double4.json")));
  const context = { characters: {}, options: {}, nopic: "", gameKey: "" };
  const api = window.StreamFGCOverlay;
  for (const fixture of fixtures) {
    const state = {
      players: { 1: { name: "One" }, 3: { name: "Three" } },
      matches: {
        A: { winner: "1" },
        C: { winner: "1" },
        E: { winner: "3" },
        F: { winner: fixture.first, loser: fixture.first === "1" ? "3" : "1" },
        G: { winner: fixture.reset }
      }
    };
    const matches = Object.keys(template.matches).map((id) => api.resolveMatch(state, template, context, id));
    assert.equal(api.championFromBracket(matches)?.id || "", fixture.champion, fixture.name);
    assert.equal(matches.find((m) => m.id === "G").player1.status === "player", fixture.eligible, fixture.name);
  }
  const single = [{ group: "finals", definition: {}, order: 1, state: { winner: "1" }, player1: { id: "1" } }];
  assert.equal(api.championFromBracket(single).id, "1");
  assert.equal(api.championFromBracket([{ ...single[0], group: "winners" }]), null);
  assert.equal(api.championFromBracket([]), null);
});

test("bracket markup keeps match cards and player details inside their rounds", () => {
  const html = window.StreamFGCOverlay.bracketHTML(
    {
      state: { current: "A" },
      matches: [
        {
          id: "A",
          name: "Opening match",
          group: "winners",
          round: "Round 1",
          state: { player1_score: 2, player2_score: 1 },
          player1: { id: "1", name: "Alice", team: "Blue" },
          player2: { id: "2", name: "Bob", team: "Red" }
        }
      ]
    },
    "all"
  );
  const stack = [];
  let players = 0;
  for (const tag of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (tag[1]) {
      assert.equal(stack.pop()?.name, tag[2], "closing tags match their enclosing elements");
      continue;
    }
    const classes = tag[3].match(/class="([^"]*)"/)?.[1].split(/\s+/) || [];
    if (classes.includes("fgc-bracket-match"))
      assert.ok(
        stack.some((parent) => parent.classes.includes("fgc-bracket-round")),
        "matches stay inside rounds"
      );
    if (classes.includes("fgc-bracket-player"))
      assert.ok(
        stack.some((parent) => parent.classes.includes("fgc-bracket-match")),
        "players stay inside match cards"
      );
    if (tag[2] === "strong" && stack.at(-1)?.classes.includes("fgc-bracket-player-copy")) players++;
    if (!/^(?:br|hr|img|input)$/.test(tag[2])) stack.push({ name: tag[2], classes });
  }
  assert.equal(players, 2, "both player names stay inside their detail containers");
  assert.equal(stack.length, 0, "the assembled bracket is balanced");
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Loads the actual controller with controlled timers and minimal form surfaces. */
function runtime(app) {
  const timers = new Map();
  let next = 0;
  let enabled = false;
  class HTMLElement {}
  const background = new HTMLElement();
  background.style = {};
  const document = {
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return background;
    }
  };
  const window = {
    go: { backend: { App: app } },
    location: { origin: "http://localhost", href: "http://localhost/frontend/" },
    localStorage: {
      getItem() {
        return String(enabled);
      }
    },
    setTimeout(fn) {
      timers.set(++next, fn);
      return next;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  // Expose the private background synchronization only in this test context.
  const source = fs.readFileSync(path.join(__dirname, "../frontend/_app.js"), "utf8").replace("Object.assign(fgc, {", "Object.assign(fgc, { syncSpaBackground,");
  vm.runInNewContext(source, { window, document, URL, HTMLElement });
  return {
    api: window.StreamFGC,
    timers,
    background,
    enable() {
      enabled = true;
      window.StreamFGC.applyAutosavePreference(true);
    }
  };
}

/** Provides the native form methods used by the real autosave implementation. */
function form() {
  return {
    isConnected: true,
    dataset: {},
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() {
      return [];
    }
  };
}

test("detached manual form cannot overwrite its saved replacement", async () => {
  const r = runtime();
  const old = form();
  const active = form();
  const writes = [];
  const options = (value) => ({
    signature: () => value,
    pending() {},
    save: async () => {
      writes.push(value);
      return value;
    }
  });
  r.api.bindAutosave(old, options("old"));
  r.api.scheduleAutosave(old, options("old"));
  old.isConnected = false;
  r.api.bindAutosave(active, options("new"));
  await r.api.flushAutosave(active, options("new"));
  r.enable();
  assert.equal(r.timers.size, 0);
  assert.equal(r.api.autosaveForms.has(old), false);
  assert.deepEqual(writes, ["new"]);
});

test("active debounce saves; dispose prevents a second in-flight iteration", async () => {
  const r = runtime();
  const active = form();
  let value = "first";
  let resolve;
  let writes = 0;
  const options = {
    signature: () => value,
    pending() {},
    save: () => {
      writes++;
      return new Promise((done) => {
        resolve = done;
      });
    }
  };
  r.api.bindAutosave(active, options);
  r.enable();
  assert.equal(r.timers.size, 1);
  const saving = r.api.flushAutosave(active, options);
  value = "later";
  r.api.scheduleAutosave(active, options);
  r.api.disposeAutosave(active);
  resolve("first");
  await saving;
  assert.equal(writes, 1);
  assert.equal(r.timers.size, 0);
  assert.equal(r.api.autosaveForms.has(active), false);
  await r.api.flushAutosave(active, options);
  assert.equal(writes, 1);
});

test("active edits during save persist the latest signature", async () => {
  const r = runtime();
  const active = form();
  let value = "first";
  let resolve;
  const writes = [];
  const options = {
    signature: () => value,
    pending() {},
    save: async () => {
      const saved = value;
      writes.push(saved);
      if (writes.length === 1)
        await new Promise((done) => {
          resolve = done;
        });
      return saved;
    }
  };
  r.api.bindAutosave(active, options);
  const saving = r.api.flushAutosave(active, options);
  value = "latest";
  resolve();
  await saving;
  assert.deepEqual(writes, ["first", "latest"]);
});

test("concurrent background synchronization waits for the pending update without blocking input", async () => {
  let release, started;
  const catalog = new Promise((resolve) => {
    release = resolve;
  });
  const loading = new Promise((resolve) => {
    started = resolve;
  });
  const r = runtime({
    ListGames() {
      started();
      return catalog;
    }
  });
  r.api.currentState = { event: { game: "game" } };
  const first = r.api.syncSpaBackground();
  await loading;
  let finished = false;
  const second = r.api.syncSpaBackground().then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  const finishedBeforeCatalog = finished;
  release([{ key: "game", background: "game.jpg" }]);
  await Promise.all([first, second]);
  assert.equal(finishedBeforeCatalog, false);
  assert.equal(r.background.style.backgroundImage, 'url("game.jpg")');
});

test("background synchronization applies the latest tournament after a delayed catalog load", async () => {
  let release, started;
  const catalog = new Promise((resolve) => {
    release = resolve;
  });
  const loading = new Promise((resolve) => {
    started = resolve;
  });
  const r = runtime({
    ListGames() {
      started();
      return catalog;
    }
  });
  r.api.currentState = { event: { game: "old" } };
  const pending = r.api.syncSpaBackground();
  await loading;
  r.api.currentState = { event: { game: "new" } };
  release([
    { key: "old", background: "old.jpg" },
    { key: "new", background: "new.jpg" }
  ]);
  await pending;
  assert.equal(r.background.style.backgroundImage, 'url("new.jpg")');
  r.api.currentState = { event: { game: "old" } };
  await r.api.syncSpaBackground();
  assert.equal(r.background.style.backgroundImage, 'url("old.jpg")');
});

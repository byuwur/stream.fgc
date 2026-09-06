"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Loads the actual controller with controlled timers and minimal form surfaces. */
function runtime() {
  const timers = new Map();
  let next = 0;
  let enabled = false;
  const document = { addEventListener() {}, querySelectorAll() { return []; } };
  const window = {
    location: { origin: "http://localhost", href: "http://localhost/frontend/" },
    localStorage: { getItem() { return String(enabled); } },
    setTimeout(fn) { timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../frontend/_app.js"), "utf8"), { window, document, URL });
  return { api: window.StreamFGC, timers, enable() { enabled = true; window.StreamFGC.applyAutosavePreference(true); } };
}

/** Provides the native form methods used by the real autosave implementation. */
function form() {
  return { isConnected: true, dataset: {}, addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; } };
}

test("detached manual form cannot overwrite its saved replacement", async () => {
  const r = runtime();
  const old = form();
  const active = form();
  const writes = [];
  const options = value => ({ signature: () => value, pending() {}, save: async () => { writes.push(value); return value; } });
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
  const options = { signature: () => value, pending() {}, save: () => { writes++; return new Promise(done => { resolve = done; }); } };
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
  const options = { signature: () => value, pending() {}, save: async () => {
    const saved = value;
    writes.push(saved);
    if (writes.length === 1) await new Promise(done => { resolve = done; });
    return saved;
  } };
  r.api.bindAutosave(active, options);
  const saving = r.api.flushAutosave(active, options);
  value = "latest";
  resolve();
  await saving;
  assert.deepEqual(writes, ["first", "latest"]);
});

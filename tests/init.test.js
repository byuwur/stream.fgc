"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function loadInitializer(values = new Map()) {
  let failure = null;
  const storage = {
    getItem(key) {
      if (failure === "get") throw new Error("get failed");
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (failure === "set") throw new Error("set failed");
      values.set(key, String(value));
    },
    removeItem(key) {
      if (failure === "remove") throw new Error("remove failed");
      values.delete(key);
    },
  };
  const window = {
    localStorage: storage,
    location: {
      href: "https://example.test/stream.fgc/frontend/index.html",
      host: "example.test",
      protocol: "https:",
    },
  };
  const context = {
    window,
    document: { currentScript: { getAttribute: () => "./_init.js" } },
    URL,
    console: { log() {} },
  };
  vm.runInNewContext(fs.readFileSync("frontend/_init.js", "utf8"), context);
  return { byStorage: window.byStorage, values, fail(mode) { failure = mode; } };
}

test("application initializer preserves per-key storage authority and migration", () => {
  const state = loadInitializer(new Map([["bySPA:/stream.fgc/frontend/:theme", "foreign"], ["ROUTER_MODE", "path"], ["legacy", "old"]]));
  const { byStorage, values } = state;
  assert.equal(byStorage.getItem("theme"), null);
  assert.equal(byStorage.getItem("legacy"), "old");
  assert.equal(values.get(`${byStorage.prefix}legacy`), "old");
  assert.equal(values.has("legacy"), false);

  values.set(`${byStorage.prefix}failed`, "persistent");
  state.fail("set");
  byStorage.setItem("failed", "local");
  assert.equal(byStorage.getItem("failed"), "local");
  values.set(`${byStorage.prefix}live`, "new");
  assert.equal(byStorage.getItem("live"), "new");

  state.fail("remove");
  values.set(`${byStorage.prefix}gone`, "old");
  byStorage.removeItem("gone");
  assert.equal(byStorage.getItem("gone"), null);
  state.fail(null);
  byStorage.setItem("gone", "restored");
  assert.equal(byStorage.getItem("gone"), "restored");
});

test("application initializer keeps storage namespaces isolated", () => {
  const values = new Map([["bySPA:/other/:theme", "other"]]);
  const { byStorage } = loadInitializer(values);
  assert.notEqual(byStorage.prefix, "bySPA:/other/:");
  assert.equal(byStorage.getItem("theme"), null);
});

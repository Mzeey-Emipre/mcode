import { expect, test } from "bun:test";

import { reloadElectronAppPage } from "./electron-session.mjs";

test("reacquires the replacement app page after an aborted reload", async () => {
  const originalPage = {
    isClosed: () => true,
    reload: async () => {
      throw new Error("reload: net::ERR_ABORTED; maybe frame was detached?");
    },
    url: () => "http://127.0.0.1:41890/",
  };
  const replacementPage = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:41890/",
  };
  const context = { pages: () => [originalPage, replacementPage] };

  await expect(reloadElectronAppPage(context, originalPage, "http://127.0.0.1:41890/"))
    .resolves.toBe(replacementPage);
});

test("does not return a page that closes during a successful reload", async () => {
  let closed = false;
  const originalPage = {
    isClosed: () => closed,
    reload: async () => { closed = true; },
    url: () => "http://127.0.0.1:41890/",
  };
  const replacementPage = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:41890/",
  };
  const context = { pages: () => [originalPage, replacementPage] };

  await expect(reloadElectronAppPage(context, originalPage, "http://127.0.0.1:41890/"))
    .resolves.toBe(replacementPage);
});

test("preserves unexpected reload failures", async () => {
  const page = {
    isClosed: () => false,
    reload: async () => {
      throw new Error("reload: navigation timeout");
    },
    url: () => "http://127.0.0.1:41890/",
  };

  await expect(reloadElectronAppPage({ pages: () => [page] }, page, "http://127.0.0.1:41890/"))
    .rejects.toThrow("reload: navigation timeout");
});

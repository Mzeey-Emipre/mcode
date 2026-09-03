import { expect, test } from "bun:test";

import {
  assertCleanupIdentity,
  assertElectronSessionState,
  assertFixtureState,
  assertOwnedSkillContent,
  assertOwnedSkillPath,
  assertOwnedStatePath,
} from "./selected-text-comments-fixture.mjs";

const state = {
  workspaceId: "fixture-workspace-id",
  threadId: "mcode-verification-selected-text-thread",
  messageId: "mcode-verification-selected-text-message",
};

test("enforces the required Electron session lifecycle", () => {
  expect(() => assertElectronSessionState("setup", false)).not.toThrow();
  expect(() => assertElectronSessionState("setup", true)).toThrow();
  expect(() => assertElectronSessionState("cleanup", true)).toThrow();
  expect(() => assertElectronSessionState("cleanup", false)).not.toThrow();
});

test("accepts only the fixture-owned state path and shape", () => {
  const root = "C:/repo";
  expect(() => assertOwnedStatePath(root, "C:/repo/.dev/verification/selected-text-comments-fixture.json")).not.toThrow();
  expect(() => assertOwnedStatePath(root, "C:/repo/.dev/verification/other.json")).toThrow();
  expect(() => assertOwnedSkillPath(root, "C:/repo/.dev/fixture-repo/.claude/skills/verification-comment/SKILL.md")).not.toThrow();
  expect(() => assertOwnedSkillPath(root, "C:/repo/.claude/skills/verification-comment/SKILL.md")).toThrow();
  expect(assertFixtureState(state)).toEqual(state);
  expect(() => assertFixtureState({ ...state, extra: "value" })).toThrow();
  expect(() => assertFixtureState({ ...state, threadId: "other-thread" })).toThrow();
  expect(() => assertFixtureState({ ...state, messageId: "other-message" })).toThrow();
});

test("rejects cleanup when the fixture skill was replaced", () => {
  expect(() => assertOwnedSkillContent("fixture skill")).toThrow();
});

test("rejects cleanup rows that do not belong to the recorded fixture", () => {
  expect(() => assertCleanupIdentity(state, {
    workspace_id: "other-workspace-id",
    title: "Selected text comments verification",
  }, undefined)).toThrow();
  expect(() => assertCleanupIdentity(state, {
    workspace_id: state.workspaceId,
    title: "Selected text comments verification",
  }, {
    id: state.messageId,
    thread_id: "other-thread-id",
  })).toThrow();
  expect(() => assertCleanupIdentity(state, undefined, undefined)).not.toThrow();
});

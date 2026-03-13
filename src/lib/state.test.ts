import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadState, type State, saveState, updateIssue } from "./state.js";

const tmpPath = join(tmpdir(), `conductor-state-test-${process.pid}.json`);

async function removeTmp() {
  const { unlink } = await import("node:fs/promises");
  // biome-ignore lint/suspicious/noEmptyBlockStatements: ignore missing tmp file
  await unlink(tmpPath).catch(() => {});
}

describe("loadState", () => {
  afterEach(removeTmp);

  it("returns empty object for missing file", async () => {
    const state = await loadState("/tmp/nonexistent-conductor-state.json");
    expect(state).toEqual({});
  });

  it("returns empty object for corrupt JSON", async () => {
    await writeFile(tmpPath, "not valid json {{{");
    const state = await loadState(tmpPath);
    expect(state).toEqual({});
  });

  it("parses valid state file and validates with Zod", async () => {
    const data = {
      42: { phase: "coding", branch: "conductor/42-fix-bug", prNumber: 101, retries: 0 },
    };
    await writeFile(tmpPath, JSON.stringify(data));
    const state = await loadState(tmpPath);
    expect(state).toEqual(data);
  });

  it("returns empty object for invalid state shape", async () => {
    await writeFile(tmpPath, JSON.stringify({ 42: { phase: 123 } }));
    const state = await loadState(tmpPath);
    expect(state).toEqual({});
  });
});

describe("saveState", () => {
  afterEach(removeTmp);

  it("writes state atomically and is readable by loadState", async () => {
    const data = {
      7: { phase: "review", branch: "conductor/7-add-auth", prNumber: 55, retries: 1 },
    };
    await saveState(tmpPath, data);
    const loaded = await loadState(tmpPath);
    expect(loaded).toEqual(data);
  });
});

describe("updateIssue", () => {
  it("merges patch into existing issue entry", () => {
    const state: State = {
      42: { phase: "coding", branch: "conductor/42-fix", prNumber: null, retries: 0 },
    };
    const next = updateIssue(state, 42, { phase: "review", prNumber: 99 });
    expect(next[42]).toEqual({
      phase: "review",
      branch: "conductor/42-fix",
      prNumber: 99,
      retries: 0,
    });
  });

  it("creates new entry when issue number does not exist", () => {
    const next = updateIssue({}, 5, {
      phase: "coding",
      branch: "conductor/5-new",
      prNumber: null,
      retries: 0,
    });
    expect(next[5]).toEqual({
      phase: "coding",
      branch: "conductor/5-new",
      prNumber: null,
      retries: 0,
    });
  });

  it("does not mutate original state", () => {
    const state: State = {
      1: { phase: "coding", branch: "b", prNumber: null, retries: 0 },
    };
    const next = updateIssue(state, 1, { phase: "done" });
    expect(state[1]?.phase).toBe("coding");
    expect(next[1]?.phase).toBe("done");
    expect(next).not.toBe(state);
  });
});

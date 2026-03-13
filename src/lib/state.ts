import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

const issueStateSchema = z.object({
  phase: z.string(),
  branch: z.string(),
  prNumber: z.number().nullable(),
  retries: z.number(),
});

const stateSchema = z.record(z.coerce.number(), issueStateSchema);

export type IssueState = z.infer<typeof issueStateSchema>;
export type State = z.infer<typeof stateSchema>;

export async function loadState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return stateSchema.parse(parsed);
  } catch {
    return {};
  }
}

export async function saveState(path: string, state: State): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, path);
}

export function updateIssue(state: State, issueNumber: number, patch: Partial<IssueState>): State {
  return {
    ...state,
    [issueNumber]: { ...state[issueNumber], ...patch } as IssueState,
  };
}

import { execaCommand } from "execa";
import { describe, expect, it, type MockedFunction, vi } from "vitest";
import { runValidation } from "./validation.js";

vi.mock("execa");

const mockExecaCommand = execaCommand as unknown as MockedFunction<typeof execaCommand>;

describe("runValidation", () => {
  it("returns ok for empty command list", async () => {
    const result = await runValidation([], "/tmp");
    expect(result).toEqual({ ok: true });
  });

  it("returns failure on first failing command with output", async () => {
    mockExecaCommand.mockResolvedValueOnce({} as never);
    mockExecaCommand.mockRejectedValueOnce({ stdout: "lint ok", stderr: "Error: bad format" });

    const result = await runValidation(["pnpm test", "pnpm lint", "pnpm build"], "/work");
    expect(result).toEqual({
      ok: false,
      command: "pnpm lint",
      output: "lint ok\nError: bad format",
    });
    expect(mockExecaCommand).toHaveBeenCalledTimes(2);
  });

  it("truncates output to last 50 lines", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    mockExecaCommand.mockRejectedValueOnce({ stdout: lines.join("\n"), stderr: "" });

    const result = await runValidation(["pnpm test"], "/work");
    expect(result).toEqual({
      ok: false,
      command: "pnpm test",
      output: lines.slice(-50).join("\n"),
    });
  });

  it("returns ok when all commands pass", async () => {
    mockExecaCommand.mockResolvedValueOnce({} as never);
    mockExecaCommand.mockResolvedValueOnce({} as never);

    const result = await runValidation(["pnpm lint", "pnpm test"], "/work");
    expect(result).toEqual({ ok: true });
    expect(mockExecaCommand).toHaveBeenCalledWith("pnpm lint", { cwd: "/work" });
    expect(mockExecaCommand).toHaveBeenCalledWith("pnpm test", { cwd: "/work" });
  });

  it("passes timeout to execaCommand when provided", async () => {
    mockExecaCommand.mockResolvedValueOnce({} as never);

    await runValidation(["pnpm lint"], "/work", 60_000);
    expect(mockExecaCommand).toHaveBeenCalledWith("pnpm lint", { cwd: "/work", timeout: 60_000 });
  });

  it("does not set timeout when not provided", async () => {
    mockExecaCommand.mockResolvedValueOnce({} as never);

    await runValidation(["pnpm lint"], "/work");
    expect(mockExecaCommand).toHaveBeenCalledWith("pnpm lint", { cwd: "/work" });
  });
});

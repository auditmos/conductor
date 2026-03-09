import { describe, expect, it } from "vitest";
import { env } from "./env.js";

describe("env", () => {
  it("should be defined", () => {
    expect(env).toBeDefined();
  });
});

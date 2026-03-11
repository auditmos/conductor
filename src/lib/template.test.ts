import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.js";

describe("renderTemplate", () => {
  it("replaces {{ variable }} placeholders with context values", () => {
    const template = "Hello, {{ name }}! You have {{ count }} items.";
    const result = renderTemplate(template, { name: "Alice", count: 3 });
    expect(result).toBe("Hello, Alice! You have 3 items.");
  });

  it("supports dot notation for nested values", () => {
    const template = "Issue: {{ issue.identifier }} — {{ issue.title }}";
    const result = renderTemplate(template, {
      "issue.identifier": "SM-42",
      "issue.title": "Fix login bug",
    });
    expect(result).toBe("Issue: SM-42 — Fix login bug");
  });

  it("replaces missing variables with empty string", () => {
    const result = renderTemplate("Hello, {{ missing }}!", {});
    expect(result).toBe("Hello, !");
  });

  it("handles empty string values", () => {
    const result = renderTemplate("Value: {{ val }}", { val: "" });
    expect(result).toBe("Value: ");
  });

  it("handles special characters in values", () => {
    const result = renderTemplate("{{ msg }}", {
      msg: '<script>alert("xss")</script>',
    });
    expect(result).toBe('<script>alert("xss")</script>');
  });

  it("returns template unchanged when no placeholders exist", () => {
    const result = renderTemplate("No placeholders here", { key: "val" });
    expect(result).toBe("No placeholders here");
  });
});

import { describe, expect, it } from "vitest";
import { formatVersion } from "../src/index.js";

describe("formatVersion", () => {
  it("formats a name and version", () => {
    expect(formatVersion("signal-ai", "0.0.1")).toBe("signal-ai v0.0.1");
  });
});

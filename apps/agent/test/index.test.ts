import { describe, expect, it } from "vitest";
import { createAgentIdentity } from "../src/index.js";

describe("createAgentIdentity", () => {
  it("derives a display name from the agent id", () => {
    expect(createAgentIdentity("abc123").displayName).toBe("agent:abc123");
  });
});

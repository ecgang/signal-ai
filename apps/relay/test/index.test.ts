import { describe, expect, it } from "vitest";
import { createRelayServerOptions } from "../src/index.js";

describe("createRelayServerOptions", () => {
  it("defaults to port 8080", () => {
    expect(createRelayServerOptions().port).toBe(8080);
  });

  it("accepts a custom port", () => {
    expect(createRelayServerOptions(9090).port).toBe(9090);
  });
});


import { describe, expect, it } from "vitest";

import {
  buildScopedMcpServerArtifacts,
  buildScopedMcpServerEndpoint,
  buildScopedMcpServerEntryName,
} from "../services/mcpServer";

describe("workspace-scoped MCP server endpoint", () => {
  it("encodes checkout identity and pins the runtime generation", () => {
    const endpoint = buildScopedMcpServerEndpoint(
      "http://127.0.0.1:27121/mcp",
      {
        checkoutId: "checkout-A/worktree?",
        expectedGeneration: 42,
        expectedMaterializationEpoch: 4,
      },
    );
    const parsed = new URL(endpoint);

    expect(`${parsed.origin}${parsed.pathname}`).toBe("http://127.0.0.1:27121/mcp");
    expect(parsed.searchParams.get("checkoutId")).toBe("checkout-A/worktree?");
    expect(parsed.searchParams.get("workspaceGeneration")).toBe("42");
    expect(parsed.searchParams.get("materializationEpoch")).toBe("4");
  });

  it("replaces stale scope parameters and rejects incomplete WorkspaceRef values", () => {
    const endpoint = buildScopedMcpServerEndpoint(
      "http://127.0.0.1:27121/mcp?checkoutId=old&workspaceGeneration=1&materializationEpoch=1",
      { checkoutId: "checkout-B", expectedGeneration: 9, expectedMaterializationEpoch: 8 },
    );
    const parsed = new URL(endpoint);
    expect(parsed.searchParams.getAll("checkoutId")).toEqual(["checkout-B"]);
    expect(parsed.searchParams.getAll("workspaceGeneration")).toEqual(["9"]);
    expect(parsed.searchParams.getAll("materializationEpoch")).toEqual(["8"]);

    expect(() => buildScopedMcpServerEndpoint(
      "http://127.0.0.1:27121/mcp",
      { checkoutId: "", expectedGeneration: 9 },
    )).toThrow("checkout ID");
    expect(() => buildScopedMcpServerEndpoint(
      "http://127.0.0.1:27121/mcp",
      { checkoutId: "checkout-B" },
    )).toThrow("checkout generation");
    expect(() => buildScopedMcpServerEndpoint("http://127.0.0.1:27121/mcp", { checkoutId: "checkout-B", expectedGeneration: 9 })).toThrow("materialization epoch");
  });

  it("builds checkout-generation-specific command and JSON artifacts", () => {
    const workspaceRef = { checkoutId: "checkout-A/worktree?", expectedGeneration: 42, expectedMaterializationEpoch: 4 };
    const artifacts = buildScopedMcpServerArtifacts(
      "http://127.0.0.1:27121/mcp",
      "tok-abc",
      workspaceRef,
    );
    expect(artifacts.entryName).toBe("locus-checkout-a-worktree");
    expect(buildScopedMcpServerEntryName(workspaceRef)).toBe(artifacts.entryName);
    expect(artifacts.endpointUrl).toContain("checkoutId=checkout-A%2Fworktree%3F");
    expect(artifacts.endpointUrl).toContain("workspaceGeneration=42");
    expect(artifacts.endpointUrl).toContain("materializationEpoch=4");
    expect(artifacts.claudeCodeCommand).toContain(artifacts.entryName);
    expect(artifacts.claudeCodeCommand).toContain(`"${artifacts.endpointUrl}"`);
    const json = JSON.parse(artifacts.jsonSnippet);
    expect(json.mcpServers[artifacts.entryName].url).toBe(artifacts.endpointUrl);
    expect(json.mcpServers[artifacts.entryName].headers.Authorization).toBe("Bearer tok-abc");
  });
});

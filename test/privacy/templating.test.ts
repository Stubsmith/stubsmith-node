import { describe, expect, it } from "vitest";
import { heuristicTemplate, loadCuratedTemplates, templatePath } from "../../src/privacy/templating.js";

describe("heuristicTemplate", () => {
  it("turns a numeric segment into {id}", () => {
    expect(heuristicTemplate("/users/123")).toBe("/users/{id}");
  });

  it("turns a UUID segment into {id}", () => {
    expect(heuristicTemplate("/users/550e8400-e29b-41d4-a716-446655440000")).toBe("/users/{id}");
  });

  it("turns 16 hex characters into {id}", () => {
    expect(heuristicTemplate("/tokens/deadbeefcafebabe")).toBe("/tokens/{id}");
  });

  it("leaves short hex literal", () => {
    expect(heuristicTemplate("/tokens/deadbeef")).toBe("/tokens/deadbeef");
  });

  it("keeps literal segments", () => {
    expect(heuristicTemplate("/api/users")).toBe("/api/users");
  });

  it("handles a mixed path", () => {
    expect(heuristicTemplate("/orders/42/items/abc123")).toBe("/orders/{id}/items/abc123");
  });

  it("keeps the leading slash", () => {
    expect(heuristicTemplate("/v1/99").startsWith("/")).toBe(true);
  });

  it("matches UUIDs in any case", () => {
    expect(heuristicTemplate("/obj/550E8400-E29B-41D4-A716-446655440000")).toBe("/obj/{id}");
  });
});

describe("loadCuratedTemplates", () => {
  it("sorts by literal count, highest first", () => {
    const curated = loadCuratedTemplates([
      "/users/{id}", // 1 literal
      "/users/{id}/orders", // 2 literals
      "/{id}", // 0 literals
    ]);
    const counts = curated.map((c) => c.literalCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("sorts ties lexicographically", () => {
    const curated = loadCuratedTemplates(["/b/{id}", "/a/{id}"]);
    expect(curated[0]?.template).toBe("/a/{id}");
    expect(curated[1]?.template).toBe("/b/{id}");
  });

  it("computes the literal count up front", () => {
    expect(loadCuratedTemplates(["/users/{id}/orders"])[0]?.literalCount).toBe(2);
  });

  it("counts every segment of an all-literal template", () => {
    expect(loadCuratedTemplates(["/api/health"])[0]?.literalCount).toBe(2);
  });

  it("does not count named wildcards as literals", () => {
    expect(loadCuratedTemplates(["/users/{userId}/orders/{p1}"])[0]?.literalCount).toBe(2);
  });

  it("sorts named wildcards correctly", () => {
    const curated = loadCuratedTemplates([
      "/v1/{p1}", // 1 literal
      "/v1/{p1}/profile", // 2 literals
    ]);
    expect(curated[0]?.template).toBe("/v1/{p1}/profile");
    expect(curated[1]?.template).toBe("/v1/{p1}");
  });
});

describe("templatePath", () => {
  it("lets a curated template win over the heuristic", () => {
    // The heuristic would keep "v1" as a literal, but the curated template makes it {id}.
    const curated = loadCuratedTemplates(["/api/{id}/detail"]);
    expect(templatePath("/api/v1/detail", curated)).toBe("/api/{id}/detail");
  });

  it("lets the template with more literals win", () => {
    const curated = loadCuratedTemplates([
      "/users/{id}", // 1 literal
      "/users/{id}/settings", // 2 literals
    ]);
    expect(templatePath("/users/42/settings", curated)).toBe("/users/{id}/settings");
  });

  it("skips a template with a different segment count and uses the heuristic", () => {
    const curated = loadCuratedTemplates(["/users/{id}/orders"]);
    expect(templatePath("/users/42", curated)).toBe("/users/{id}");
  });

  it("uses the heuristic when no curated template matches", () => {
    const curated = loadCuratedTemplates(["/products/{id}"]);
    expect(templatePath("/orders/99/items", curated)).toBe("/orders/{id}/items");
  });

  it("uses the heuristic for an empty curated list", () => {
    expect(templatePath("/v2/widgets/abc123def456789a", [])).toBe("/v2/widgets/{id}");
  });

  it("matches an exact literal template", () => {
    const curated = loadCuratedTemplates(["/health"]);
    expect(templatePath("/health", curated)).toBe("/health");
  });

  it("matches the named wildcard {p1} to a concrete segment", () => {
    const curated = loadCuratedTemplates(["/v1/{p1}/profile"]);
    expect(templatePath("/v1/abc123/profile", curated)).toBe("/v1/{p1}/profile");
  });

  it("matches the named wildcard {userId} to a numeric segment", () => {
    const curated = loadCuratedTemplates(["/users/{userId}/orders"]);
    expect(templatePath("/users/42/orders", curated)).toBe("/users/{userId}/orders");
  });

  it("orders templates with equal literal counts lexicographically", () => {
    const curated = loadCuratedTemplates(["/users/{id}/orders", "/users/{userId}/orders"]);
    expect(templatePath("/users/42/orders", curated)).toBe("/users/{id}/orders");
  });

  it("still matches a segment spelled like its wildcard name", () => {
    // A template segment {p1} is a wildcard, not a literal to match against the concrete segment "p1".
    const curated = loadCuratedTemplates(["/api/{p1}/data"]);
    expect(templatePath("/api/p1/data", curated)).toBe("/api/{p1}/data");
  });
});

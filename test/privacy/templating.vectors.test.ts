import { describe, expect, it } from "vitest";
import { loadCuratedTemplates, templatePath } from "../../src/privacy/templating.js";
import { loadVectors } from "../helpers/vectors.js";

interface In {
  path: string;
  templates: string[];
}
interface Ex {
  template: string;
  sorted_templates: Array<{ literal_count: number; template: string }>;
}

const file = loadVectors<In, Ex>("templating.json");

describe("templating conformance vectors", () => {
  it.each(file.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const curated = loadCuratedTemplates(c.input.templates);
    expect(curated.map((t) => ({ literal_count: t.literalCount, template: t.template }))).toEqual(
      c.expected.sorted_templates,
    );
    expect(templatePath(c.input.path, curated)).toBe(c.expected.template);
  });
});

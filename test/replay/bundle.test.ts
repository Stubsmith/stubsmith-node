import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBundleUpward, loadBundle, resolveBundle } from "../../src/replay/bundle.js";
import { ReplayEngine } from "../../src/replay/engine.js";
import { replay } from "../../src/replay/index.js";
import { FP_EMPTY_GET, bundle, endpoint, stub, tempDir, variant, writeJson } from "./helpers.js";

let tmp: { dir: string; cleanup: () => void };
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = tempDir();
  savedEnv = process.env["STUBSMITH_BUNDLE"];
  delete process.env["STUBSMITH_BUNDLE"];
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
  if (savedEnv === undefined) delete process.env["STUBSMITH_BUNDLE"];
  else process.env["STUBSMITH_BUNDLE"] = savedEnv;
});

const marked = (tag: string) => bundle(endpoint("GET", `/${tag}`, [stub(FP_EMPTY_GET, [variant(200, "1")])]));
const tagOf = (b: { endpoints: Array<{ path_template: string }> }): string => b.endpoints[0]?.path_template ?? "";
const at = (...parts: string[]): string => path.join(tmp.dir, ...parts);
const cwd = (dir: string): void => void vi.spyOn(process, "cwd").mockReturnValue(dir);

describe("loadBundle", () => {
  it("returns an in-memory object as is", () => {
    const b = marked("a");
    expect(loadBundle(b)).toBe(b);
  });
  it("loads a path", () => {
    writeJson(at("b.json"), marked("file"));
    expect(tagOf(loadBundle(at("b.json")))).toBe("/file");
  });
  it("strips a leading BOM", () => {
    fs.writeFileSync(at("bom.json"), `\uFEFF${JSON.stringify(marked("bom"))}`);
    expect(tagOf(loadBundle(at("bom.json")))).toBe("/bom");
  });
  it("a missing file names the path and tells you to pull", () => {
    expect(() => loadBundle(at("nope.json"))).toThrow(/Bundle file not found: .*nope\.json\. Run 'stubsmith pull'/);
  });
  it("malformed JSON and a non-object document are clear errors", () => {
    fs.writeFileSync(at("bad.json"), "{nope");
    expect(() => loadBundle(at("bad.json"))).toThrow(/is not valid JSON/);
    fs.writeFileSync(at("arr.json"), "[1]");
    expect(() => loadBundle(at("arr.json"))).toThrow(/must contain a JSON object at the top level/);
  });
  it("rejects values that are neither an object nor a path", () => {
    expect(() => loadBundle(null as unknown as string)).toThrow(TypeError);
    expect(() => loadBundle([] as unknown as string)).toThrow(TypeError);
  });
  it("an object body in a file keeps its number tokens, so 1.0 and large ints serve like Python json.dumps", () => {
    fs.writeFileSync(
      at("b.json"),
      `{"endpoints": [{"domain": "api.example.com", "method": "GET", "path_template": "/o", "stubs": [{"fingerprint": "${FP_EMPTY_GET}", "key_paths": [], "variants": [{"status": 200, "count": 1, "headers": {}, "body": {"f": 1.0, "big": 12345678901234567890, "s": "x"}}]}]}]}`,
    );
    const e = new ReplayEngine(loadBundle(at("b.json")));
    const r = e.serve({ method: "GET", url: "https://api.example.com/o" });
    expect(new TextDecoder().decode(r.body)).toBe('{"f": 1.0, "big": 12345678901234567890, "s": "x"}');
  });
});

describe("resolveBundle order", () => {
  it("the argument wins over $STUBSMITH_BUNDLE and the upward search", () => {
    writeJson(at("arg.json"), marked("arg"));
    writeJson(at("env.json"), marked("env"));
    writeJson(at(".stubsmith", "bundle.json"), marked("default"));
    fs.mkdirSync(at(".git"));
    process.env["STUBSMITH_BUNDLE"] = at("env.json");
    cwd(tmp.dir);
    const r = resolveBundle(at("arg.json"));
    expect(tagOf(r.bundle)).toBe("/arg");
    expect(r.path).toBe(at("arg.json"));
  });

  it("an object argument has no path", () => {
    expect(resolveBundle(marked("obj")).path).toBeNull();
  });

  it("$STUBSMITH_BUNDLE wins over the upward search", () => {
    writeJson(at("env.json"), marked("env"));
    writeJson(at(".stubsmith", "bundle.json"), marked("default"));
    process.env["STUBSMITH_BUNDLE"] = at("env.json");
    cwd(tmp.dir);
    expect(tagOf(resolveBundle().bundle)).toBe("/env");
  });

  it("an empty $STUBSMITH_BUNDLE is ignored", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("default"));
    process.env["STUBSMITH_BUNDLE"] = "";
    cwd(tmp.dir);
    expect(tagOf(resolveBundle().bundle)).toBe("/default");
  });

  it("a $STUBSMITH_BUNDLE pointing nowhere is an error, not a silent fall-through", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("default"));
    process.env["STUBSMITH_BUNDLE"] = at("gone.json");
    cwd(tmp.dir);
    expect(() => resolveBundle()).toThrow(/Bundle file not found/);
  });

  it("replay() exposes the resolved path on the context", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("default"));
    fs.mkdirSync(at(".git"));
    cwd(tmp.dir);
    const r = replay();
    try {
      expect(r.bundlePath).toBe(at(".stubsmith", "bundle.json"));
    } finally {
      r.restore();
    }
  });
});

describe("upward search", () => {
  it("finds the bundle in the working directory", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("here"));
    expect(findBundleUpward(tmp.dir)).toBe(at(".stubsmith", "bundle.json"));
  });

  it("finds it several levels up", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("up"));
    fs.mkdirSync(at("a", "b", "c"), { recursive: true });
    cwd(at("a", "b", "c"));
    expect(tagOf(resolveBundle().bundle)).toBe("/up");
  });

  it("prefers the nearest bundle", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("far"));
    writeJson(at("a", ".stubsmith", "bundle.json"), marked("near"));
    fs.mkdirSync(at("a", "b"));
    cwd(at("a", "b"));
    expect(tagOf(resolveBundle().bundle)).toBe("/near");
  });

  it("stops at a .git boundary: a bundle above it is not picked up", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("outside"));
    fs.mkdirSync(at("proj", ".git"), { recursive: true });
    fs.mkdirSync(at("proj", "src"));
    expect(findBundleUpward(at("proj", "src"))).toBeNull();
    cwd(at("proj", "src"));
    expect(() => resolveBundle()).toThrow(/No bundle found/);
  });

  it("stops at a package.json boundary", () => {
    writeJson(at(".stubsmith", "bundle.json"), marked("outside"));
    writeJson(at("proj", "package.json"), {});
    fs.mkdirSync(at("proj", "src"));
    expect(findBundleUpward(at("proj", "src"))).toBeNull();
  });

  it("still checks the boundary directory itself", () => {
    writeJson(at("proj", ".stubsmith", "bundle.json"), marked("at-boundary"));
    writeJson(at("proj", "package.json"), {});
    fs.mkdirSync(at("proj", "src"));
    expect(findBundleUpward(at("proj", "src"))).toBe(at("proj", ".stubsmith", "bundle.json"));
  });

  it("a .stubsmith/bundle.json that is a directory is not a bundle", () => {
    fs.mkdirSync(at(".stubsmith", "bundle.json"), { recursive: true });
    fs.mkdirSync(at(".git"));
    expect(findBundleUpward(tmp.dir)).toBeNull();
  });

  it("the not-found error says where it searched and what to do", () => {
    fs.mkdirSync(at(".git"));
    cwd(tmp.dir);
    let message = "";
    try {
      resolveBundle();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("No bundle found. Searched for '.stubsmith/bundle.json' starting from " + tmp.dir);
    expect(message).toContain("up to the first .git / package.json boundary");
    expect(message).toContain("set $STUBSMITH_BUNDLE");
    expect(message).toContain("run 'stubsmith pull'");
  });

  it("replay() throws on a missing bundle before installing anything", () => {
    fs.mkdirSync(at(".git"));
    cwd(tmp.dir);
    const before = globalThis.fetch;
    expect(() => replay()).toThrow(/No bundle found/);
    expect(globalThis.fetch).toBe(before);
  });

  it("replay() rejects an unsupported onMiss", () => {
    expect(() => replay({ bundle: marked("x"), onMiss: "passthrough" as unknown as "strict" })).toThrow(/onMiss/);
  });
});

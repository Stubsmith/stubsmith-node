import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    // The bundler drops the `/// <reference lib>` in context.ts; ReplayContext extends Disposable, so restore it.
    dts: { banner: '/// <reference lib="esnext.disposable" />' },
    sourcemap: true,
    clean: true,
    target: "node22",
  },
  {
    // The CLI is only ever run as `dist/cli.js` (bin), so ESM alone is enough.
    entry: ["src/cli.ts"],
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
  },
]);

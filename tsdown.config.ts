import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    lib: "src/lib.ts",
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: true,
  shims: true,
});

import copy from "esbuild-plugin-copy";
import { defineConfig } from "tsup";

export default defineConfig([
   {
      entry: ["src/index.ts"],
      format: ["cjs", "esm"],
      dts: true,
      clean: true,
      treeshake: true,
      external: ["ioredis"],
      esbuildPlugins: [
         copy({
            assets: [{ from: "build/redis.wasm", to: "redis.wasm" }],
         }),
      ],
   },
]);

# wasm-redis: Architecture, Build, and Runtime Guide

This document summarizes how this project compiles and runs Redis entirely inside WebAssembly (WASM) under Node.js, the key changes made to upstream sources for Emscripten, runtime configuration (including memory limits), and how to test and extend it.

## Overview

- Runs an embedded Redis server inside a single WASM module with no network listeners.
- Uses a C shim to initialize Redis and process commands fully in-process.
- Provides a small TypeScript wrapper to load the WASM module and send RESP commands.
- Compiles with Emscripten and targets Node.js (`-s ENVIRONMENT=node`).

## Repository structure

- `vendor/redis/` – Upstream Redis/Valkey sources (as a git submodule). We build from `vendor/redis/src`.
- `wasm/`
  - `shim.c` – Initializes the Redis server without sockets and exposes C-callable entrypoints.
  - `compat.c` – Small compatibility stubs for missing tool-only symbols (e.g., TLS, rdbCheckMode).
- `src/`
  - `index.ts` – TypeScript wrapper that loads the Emscripten-generated module and exposes a minimal client API with configurable memory limits.
- `dist/wasm/`
  - `redis.js`/`redis.wasm` – Emscripten artifacts produced by the build.
- `test/` – Vitest tests covering basic commands and Lua.
- `Makefile` – Orchestrates the Emscripten build and links the required Redis sources.
- `compile` – Convenience script that runs `make` inside the `emscripten/emsdk` Docker image.

## C entrypoints (WASM exports)

We export three functions from the native side (see Makefile link flags):

- `_redis_init()` – One-time initialization. Sets up config and subsystems, without creating any network listeners.
- `_redis_exec(in_ptr, in_len, out_ptr_ptr, out_len_ptr)` – Executes a RESP command buffer and allocates a RESP reply buffer.
- `_redis_free(ptr, len)` – Frees a buffer returned by `_redis_exec`.

These functions are wrapped from JS/TS via `Module.cwrap` in `src/index.ts`.

## Emscripten build details

Primary flags (see `Makefile`):

- `-s ALLOW_MEMORY_GROWTH=1` – Growable memory for large workloads.
- `-s ENVIRONMENT=node` – Targets Node.js (not browsers by default).
- `-s MODULARIZE=1 -s EXPORT_ES6=1` – Exports an ES module factory (`default`).
- `-s NO_EXIT_RUNTIME=1` – Keep runtime alive after init.
- `-s ASSERTIONS=2 -s SAFE_HEAP=1` – Debuggability and safety checks.
- `-s SUPPORT_LONGJMP=1` – Needed by Redis/Lua error mechanics.
- `-s ERROR_ON_UNDEFINED_SYMBOLS=0` – Allow unresolved symbols used by optional tool binaries (e.g., redis-check-*); these are unused at runtime here.
- `-s EXPORTED_FUNCTIONS` – Exports `_malloc`, `_free`, and the three Redis entrypoints.

Build command:

```bash
./compile
```

This runs `make` inside the `emscripten/emsdk` Docker image. Artifacts are generated in `dist/wasm/`.

## Runtime model (no TCP, fully in-process)

The WASM module runs Redis in the same process and thread:

- `wasm/shim.c`
  - Calls `initServerConfig()` and `initServer()` directly (bypassing `main()`), so we can control startup.
  - Disables TCP listeners: `server.port = 0`.
  - Processes commands via `moduleAllocTempClient()` + `processInputBuffer()` and returns the RESP reply.
  - Sets a default maxmemory (see below).
- No background fork processes or network I/O are used in this setup.

## Memory limits (maxmemory)

- Default: The shim sets a conservative default of 256 MB with `noeviction`:
  - In `wasm/shim.c` (before `initServer()`):
    - `server.maxmemory = 256LL * (1024 * 1024);`
    - `server.maxmemory_policy = MAXMEMORY_NO_EVICTION;`
- Why: Prevents the upstream `server.c` from auto-assigning a 3 GB limit on 32-bit builds:
  - In upstream, when `arch_bits == 32` and `maxmemory == 0`, it sets 3 GB and logs a warning.
  - Our explicit default avoids this and suits WASM constraints better.
- Runtime override from JS/TS: After `redis_init`, we apply overrides if provided via `WasmRedisOptions` (see below), using `CONFIG SET`.

## Node wrapper API

`src/index.ts` exposes a small client for Node.js:

```ts
import { createClient } from './index';

const client = await createClient({
  maxmemory: '128mb',            // or 134217728
  maxmemoryPolicy: 'noeviction', // or 'allkeys-lru', etc.
});

const reply = await client.call('PING');
```

- `WasmRedisOptions`:
  - `maxmemory?: number | string` – Bytes or Redis-style sizes (e.g., `128mb`).
  - `maxmemoryPolicy?: 'noeviction' | 'allkeys-lru' | 'allkeys-lfu' | 'allkeys-random' | 'volatile-lru' | 'volatile-lfu' | 'volatile-random' | 'volatile-ttl'`.
- The wrapper sends RESP arrays and returns the raw RESP reply as `Uint8Array`.

## Emscripten-specific source changes

To make the upstream sources work cleanly under Emscripten, we made these minimal adjustments:

- `vendor/redis/src/server.c`
  - Guarded `adjustOpenFilesLimit()` for Emscripten to avoid `getrlimit/setrlimit`:
    - On native Linux these use `prlimit64`; under WASM this syscall is unsupported and logs warnings.
    - On `__EMSCRIPTEN__`, the function now returns early, avoiding the call.
- `wasm/compat.c`
  - Provides tiny stubs for symbols used only by optional tools/features:
    - `int rdbCheckMode = 0;`
    - `int RedisRegisterConnectionTypeTLS(void) { return C_ERR; }`
- `wasm/shim.c`
  - Sets `server.port = 0` to prevent opening network sockets.
  - Sets default `maxmemory` and `maxmemory_policy` before `initServer()`.
  - Exposes `_redis_init`, `_redis_exec`, and `_redis_free`.

These changes are intentionally small and self-contained. The majority of the upstream code is left untouched.

## Notes on warnings and logging

- `unsupported syscall: __syscall_prlimit64`
  - Fixed by guarding `adjustOpenFilesLimit()` on Emscripten.
- 32-bit memory notice (“Setting 3 GB maxmemory…”) 
  - Avoided by setting a default 256 MB `maxmemory` in the shim before `initServer()`.
- Monotonic clock log: `"monotonic clock: POSIX clock_gettime"`
  - Emitted by upstream during initialization; harmless.
- Build-time undefined symbol warnings
  - Expected for optional tool symbols; we pass `-s ERROR_ON_UNDEFINED_SYMBOLS=0` and don’t call those paths.

## Testing

We use Vitest for Node.js:

```bash
pnpm vitest run
```

Current tests include:

- Basic commands: `PING`, `SET/GET`, `INCR`, and error replies.
- Lua script execution: `EVAL` returning arrays and integers, and basic set/get within Lua.

## Limitations and scope

- No network listeners are created; everything runs in-process.
- Persistence (AOF/RDB) features are compiled in, but are not exercised in this setup.
- Single-threaded runtime; background fork operations or I/O threads are not used.
- Target is Node.js. Browser support would require a different Emscripten configuration and likely further adjustments.

## Extensibility ideas

- Expose a dedicated runtime API for tuning (e.g., additional `CONFIG SET` helpers or C-callable setters for `maxmemory`).
- Add more tests around eviction policies and memory pressure.
- Consider a browser build variant (`-s ENVIRONMENT=web,worker` and enabling required syscalls/shims).

## Quick usage reference

```ts
import { createClient } from './index';

async function demo() {
  const client = await createClient({ maxmemory: '256mb', maxmemoryPolicy: 'noeviction' });
  const resp = await client.call('PING');
  console.log(Buffer.from(resp).toString('utf8')); // +PONG\r\n
  await client.call('SET', 'k', 'v');
  const got = await client.call('GET', 'k');
  console.log(Buffer.from(got).toString('utf8')); // $1\r\nv\r\n
  // Lua example
  const lua = 'return {KEYS[1],ARGV[1]}';
  const luaResp = await client.call('EVAL', lua, '1', 'k', 'arg');
  console.log(Buffer.from(luaResp).toString('utf8')); // *2\r\n$1\r\nk\r\n$3\r\narg\r\n
}

demo();
```

## Changelog of key changes (WASM integration)

- Added Emscripten build via `Makefile` and `compile` script.
- Introduced `wasm/shim.c` with in-process execution entrypoints.
- Added `wasm/compat.c` with minimal stubs for tool-only symbols.
- Guarded `adjustOpenFilesLimit()` in `vendor/redis/src/server.c` for Emscripten.
- Defaulted `maxmemory` to 256 MB with `noeviction` in the shim; made both configurable from TS at runtime.
- Added TypeScript wrapper with `createClient()` and a minimal RESP encoder/decoder path.
- Added Vitest tests for basic commands and Lua.

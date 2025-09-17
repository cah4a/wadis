Wadis
=======
***Web Assembly Dictionary Service***

---

A high-speed, ephemeral Wasm build of the Redis® open-source code, optimized for automated testing.

Instant boot, zero persistence. Ideal for test runners in Bun and Node.js.

## Why Wadis?

Testing code that interacts with Redis can be slow and flaky. Traditional solutions require running a separate 
Redis server, often in Docker, which adds significant overhead to test startup and teardown.

Wadis solves this by compiling the Redis server directly to WebAssembly.

- ✅ **Instant Boot**: Starts in milliseconds, not seconds.
- ✅ **Zero State Collision**: Every instance is perfectly isolated. Since persistence is disabled, you get a 100% clean slate on every run.
- ✅ **Zero Dependencies**: No Docker, no external binaries. Just a lightweight npm package that runs in-process with your tests.
- ✅ **High Fidelity**: This isn't a rewrite. It's a build of the original Redis source code, so you can test with confidence.
- ✅ ****: Supports advanced Redis features like Pub/Sub and Lua scripting.

## Quick Start

```bash
npm install -D wadis
# or
pnpm install -D wadis
# or
bun add -D wadis
```

## Usage

This package provides two APIs: a high-level ioredis-compatible client (recommended for most users) and a low-level server API.

### 1. Simple ioredis-compatible API

The `Wadis` class is an [ioredis](https://github.com/redis/ioredis) subclass that automatically 
creates and manages its own in-process Wasm server.

```ts
import { Wadis } from 'wadis';

// 1. Instantiating creates a new, isolated server in memory
const redis = new Wadis();

// 2. Use standard ioredis commands
await redis.set('foo', 'bar');
console.log(await redis.get('foo')); // 'bar'

await redis.incr('counter');
const counter = await redis.get('counter');
console.log(counter); // '1'

// 3. Close the connection and terminate the Wasm instance
await redis.quit();
```

### 2. Shared Server Instance

For some test setups, you may want to create a single server instance and share it across multiple client connections.

```ts
import { Wadis, WadisServer } from 'wadis';

// 1. Create a single server instance
const server = await WadisServer.new();

// 2. Create clients that connect to the same in-process server
const client1 = new Wadis({ server });
const client2 = new Wadis({
   server,
   // You can still pass other ioredis options
   maxRetriesPerRequest: null,
});

await client1.set('shared-key', 'hello');
const val = await client2.get('shared-key');
console.log(val); // 'hello'

await client1.quit();
await client2.quit();
await server.terminate();
```

### 3. Low-level Server API

For advanced use cases, you can interact with the server directly. 
It accepts raw Redis commands and returns raw RESP (REdis Serialization Protocol) replies.

```ts
import { WadisServer } from 'wadis';

const server = await WadisServer.new({
   // Pass configuration options directly
   maxmemory: '128mb',
   maxmemoryPolicy: 'allkeys-lru',
   loglevel: 'notice', // 'debug', 'verbose', 'notice', 'warning'
});

// `call` sends raw commands and returns raw RESP replies as a Uint8Array
const reply = await server.call('PING');
// You must decode the RESP response
console.log(new TextDecoder().decode(reply)); // "+PONG\r\n"

await server.call('SET', 'foo', 'bar');
const res = await server.call('GET', 'foo');
console.log(new TextDecoder().decode(res)); // "$3\r\nbar\r\n"

// Terminate the Wasm instance
server.terminate();
```


## How It Works

This library compiles the Redis server to WebAssembly using Emscripten, exposing a minimal C API for server interaction.

- `redis_init()` is called to initialize the server configuration without binding to network ports.
- Commands are executed by simulating an internal client, bypassing the network stack entirely.
- The WebAssembly binary runs in-process within your Node.js or Bun runtime, requiring zero external binaries or network overhead.


## Building from Source

### Prerequisites

- Node.js 20+
- Docker (for building WebAssembly)

### Build Process

```bash
git submodule update --init --recursive

# Build WebAssembly module (requires Docker)
./compile

# Install dependencies and build TypeScript wrapper
pnpm install
pnpm run build
```

## License

The source code for Wadis is distributed under the terms of the Redis Source Available License v2 (RSALv2).

## Trademark Disclaimer

Wadis is an independent project and is not affiliated with, endorsed by, or sponsored by Redis Ltd.
Redis is a registered trademark of Redis Ltd. Any rights therein are reserved to Redis Ltd.

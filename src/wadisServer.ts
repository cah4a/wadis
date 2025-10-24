// @ts-expect-error
import redis from "wasm/redis.js";

export type WadisOptions = {
   // Configurable Redis memory cap. Accepts a number of bytes or a Redis-size string like '128mb'.
   maxmemory?: number | string;
   // Eviction policy, matches Redis config: 'noeviction', 'allkeys-lru', etc.
   maxmemoryPolicy?:
      | "noeviction"
      | "allkeys-lru"
      | "allkeys-lfu"
      | "allkeys-random"
      | "volatile-lru"
      | "volatile-lfu"
      | "volatile-random"
      | "volatile-ttl"
      | string;
   // Redis loglevel: 'debug' | 'verbose' | 'notice' | 'warning'
   loglevel?: "debug" | "verbose" | "notice" | "warning" | string;
};

type EmscriptenModule = {
   cwrap: (
      ident: string,
      returnType: string,
      argTypes: string[],
   ) => (...args: unknown[]) => unknown;
   _malloc: (n: number) => number;
   _free: (ptr: number) => void;
   writeArrayToMemory?: (arr: Uint8Array, ptr: number) => void;
   setValue?: (ptr: number, value: number, type: string) => void;
   getValue: (ptr: number, type: string) => number;
};

export class WadisServer {
   private Module: EmscriptenModule | null = null;
   private _clientHandle: number | null = null;

   private constructor(private _opts: WadisOptions = {}) {}

   static async new(
      opts: WadisOptions = { loglevel: "debug" },
   ): Promise<WadisServer> {
      const server = new WadisServer(opts);
      await server.start();
      return server;
   }

   async start(): Promise<void> {
      this.Module = (await redis({ noInitialRun: true })) as EmscriptenModule;

      const init = this.Module.cwrap("redis_init", "number", ["number"]) as (
         level: number,
      ) => number;
      const rc = init(this.loglevelToInt(this._opts.loglevel ?? "warning"));
      if (rc !== 0) throw new Error(`redis_init failed: ${rc}`);

      // Create a persistent client used by call(). This unifies command execution
      // with the same mechanism the adapter uses, enabling push semantics when needed.
      this._clientHandle = this._createHandle();

      // Apply runtime configuration overrides if provided.
      if (this._opts.maxmemory !== undefined) {
         const val =
            typeof this._opts.maxmemory === "number"
               ? String(this._opts.maxmemory)
               : this._opts.maxmemory;
         await this.call("CONFIG", "SET", "maxmemory", val);
      }
      if (this._opts.maxmemoryPolicy) {
         await this.call(
            "CONFIG",
            "SET",
            "maxmemory-policy",
            this._opts.maxmemoryPolicy,
         );
      }
      if (this._opts.loglevel) {
         await this.call("CONFIG", "SET", "loglevel", this._opts.loglevel);
      }
   }

   // Minimal RESP encoder for array of bulk strings: *N\r\n$len\r\nfoo\r\n...
   private encodeCommand(parts: (string | Buffer)[]): Uint8Array {
      const chunks: Buffer[] = [];
      chunks.push(Buffer.from(`*${parts.length}\r\n`));
      for (const p of parts) {
         const b = Buffer.isBuffer(p) ? p : Buffer.from(p);
         chunks.push(Buffer.from(`$${b.length}\r\n`));
         chunks.push(b);
         chunks.push(Buffer.from(`\r\n`));
      }
      return Buffer.concat(chunks);
   }

   async call(...parts: (string | Buffer)[]): Promise<Uint8Array> {
      if (!this.Module) throw new Error("WASM not started");
      if (!this._clientHandle) this._clientHandle = this._createHandle();
      const input = this.encodeCommand(parts);
      this._clientFeed(this._clientHandle, input);
      const out = this._clientRead(this._clientHandle);
      return out ?? new Uint8Array(0);
   }

   private _createHandle(): number {
      if (!this.Module) throw new Error("WASM not started");
      const mod = this.Module as EmscriptenModule;
      const fn = mod.cwrap("redis_create_handle", "number", []) as () => number;
      const h = fn();
      if (!h) throw new Error("redis_create_handle failed");
      return h;
   }

   private _clientFeed(handle: number, data: Uint8Array | Buffer): void {
      if (!this.Module) throw new Error("WASM not started");
      const mod = this.Module as EmscriptenModule;
      const feed = mod.cwrap("redis_client_feed", "number", [
         "number",
         "number",
         "number",
      ]) as (h: number, ptr: number, len: number) => number;
      const malloc = mod._malloc as (n: number) => number;
      const free = mod._free as (ptr: number) => void;
      const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const inPtr = malloc(input.length);
      if (typeof mod.writeArrayToMemory === "function") {
         mod.writeArrayToMemory(input, inPtr);
      } else if (typeof mod.setValue === "function") {
         for (let i = 0; i < input.length; i++)
            mod.setValue(inPtr + i, input[i], "i8");
      } else {
         throw new Error(
            "Emscripten runtime missing writeArrayToMemory/setValue",
         );
      }
      const rc = feed(handle, inPtr, input.length);
      free(inPtr);
      if (rc !== 0) throw new Error(`redis_client_feed failed: ${rc}`);
   }

   private _clientRead(handle: number): Uint8Array | null {
      if (!this.Module) throw new Error("WASM not started");
      const mod = this.Module as EmscriptenModule;
      const malloc = mod._malloc as (n: number) => number;
      const free = mod._free as (ptr: number) => void;
      const read = mod.cwrap("redis_client_read", "number", [
         "number",
         "number",
         "number",
      ]) as (h: number, outPtrPtr: number, outLenPtr: number) => number;
      const freeOut = mod.cwrap("redis_free", "void", ["number", "number"]) as (
         ptr: number,
         len: number,
      ) => void;

      const outPtrPtr = malloc(4);
      const outLenPtr = malloc(4);
      const rc = read(handle, outPtrPtr, outLenPtr);
      if (rc !== 0) {
         free(outPtrPtr);
         free(outLenPtr);
         throw new Error(`redis_client_read failed: ${rc}`);
      }
      const outPtr = mod.getValue(outPtrPtr, "i32") as number;
      const outLen = mod.getValue(outLenPtr, "i32") as number;
      free(outPtrPtr);
      free(outLenPtr);
      if (!outPtr || outLen === 0) return null;

      const out = new Uint8Array(outLen);
      for (let i = 0; i < outLen; i++)
         out[i] = mod.getValue(outPtr + i, "i8") as number;
      freeOut(outPtr, outLen);
      return out;
   }

   private _clientFree(handle: number): void {
      if (!this.Module) return;
      const mod = this.Module as EmscriptenModule;
      const fn = mod.cwrap("redis_client_free", "void", ["number"]) as (
         h: number,
      ) => void;
      fn(handle);
   }

   private _clientWantsClose(handle: number): boolean {
      if (!this.Module) return false;
      const mod = this.Module as EmscriptenModule;
      const fn = mod.cwrap("redis_client_wants_close", "number", [
         "number",
      ]) as (h: number) => number;
      return fn(handle) !== 0;
   }

   createConnection() {
      if (!this.Module) throw new Error("WASM not started");
      const handle = this._createHandle();
      return {
         write: (data: Uint8Array | Buffer) => this._clientFeed(handle, data),
         read: () => this._clientRead(handle),
         wantsClose: () => this._clientWantsClose(handle),
         close: () => this._clientFree(handle),
      } as const;
   }

   async terminate() {
      if (this._clientHandle !== null) {
         this._clientFree(this._clientHandle);
      }

      this.Module = null;
      this._clientHandle = null;
   }

   private loglevelToInt(level: string): number {
      const s = level.toLowerCase();
      if (s === "debug") return 0;
      if (s === "verbose") return 1;
      if (s === "notice") return 2;
      return 3;
   }
}

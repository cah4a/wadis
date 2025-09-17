import type { WadisServer } from "wadisServer";
import { Socket } from "node:net";

export class WadisServerConnector extends Socket {
   private conn: {
      write: (data: Uint8Array | Buffer) => void;
      read: () => Uint8Array | null;
      wantsClose: () => boolean;
      close: () => void;
   };
   private poll?: NodeJS.Timeout;
   private _closed = false;
   private queue: Promise<void> = Promise.resolve();

   constructor(server: WadisServer) {
      super();
      this.conn = server.createConnection();
      this.startPolling();
      setImmediate(() => this.emit("connect"));
   }

   override setTimeout(_msecs: number, _callback?: () => void): this {
      return this;
   }
   override setNoDelay(_noDelay?: boolean): this {
      return this;
   }
   override setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
      return this;
   }

   override write(
      chunk: Uint8Array | string,
      encoding?: BufferEncoding | ((err?: Error) => void),
      cb?: (err?: Error) => void,
   ): boolean {
      let callback: ((err?: Error) => void) | undefined;
      let enc: BufferEncoding | undefined;
      if (typeof encoding === "function") {
         callback = encoding;
      } else {
         enc = encoding as BufferEncoding | undefined;
         callback = cb;
      }
      const buf =
         typeof chunk === "string"
            ? Buffer.from(chunk, enc ?? "utf8")
            : Buffer.from(chunk);
      // Ensure replies are emitted asynchronously after write returns,
      // and preserve write ordering with a micro-queue.
      this.queue = this.queue.then(
         () =>
            new Promise<void>((resolve) => {
               setImmediate(() => {
                  try {
                     this.conn.write(buf);
                  } catch (err) {
                     this.emit("error", err as Error);
                  } finally {
                     resolve();
                  }
               });
            }),
      );
      if (callback) setImmediate(() => callback());
      return true;
   }

   override end(..._args: unknown[]): this {
      if (this._closed) return this;
      this._closed = true;
      if (this.poll) {
         clearInterval(this.poll);
         this.poll = undefined;
      }
      this.conn.close();
      setImmediate(() => this.emit("end"));
      setImmediate(() => this.emit("close", false));
      return this;
   }
   override destroy(_error?: Error): this {
      if (this._closed) return this;
      this._closed = true;
      if (this.poll) {
         clearInterval(this.poll);
         this.poll = undefined;
      }
      this.conn.close();
      setImmediate(() => this.emit("close", true));
      return this;
   }
   private startPolling() {
      this.poll = setInterval(() => this.drain(), 10);
      // Do not keep the process alive solely due to this timer
      // (important for tests that don't explicitly quit the base connection)
      this.poll.unref?.();
   }

   private drain() {
      while (true) {
         const out = this.conn.read();
         if (!out || out.length === 0) break;
         this.emit("data", Buffer.from(out));
      }
      // After draining all pending output, if Redis marked this client
      // to close after reply (QUIT), close the socket gracefully.
      if (!this._closed && this.conn.wantsClose()) {
         this.end();
      }
   }
}

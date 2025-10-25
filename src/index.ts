import { WadisServer } from "wadisServer";
import { WadisServerConnector } from "adapters/ioredis";
import Redis, { AbstractConnector, type RedisOptions } from "ioredis";
import type { ErrorEmitter } from "ioredis/built/connectors/AbstractConnector";

export * from "wadisServer";

export type WadisOptions = Omit<
   RedisOptions,
   "Connector" | "host" | "port" | "username" | "password" | "db"
> & {
   server?: WadisServer | Promise<WadisServer>;
};

export class Wadis extends Redis {
   constructor({ server, ...options }: WadisOptions = {}) {
      const wasmServer = server ?? WadisServer.new();

      class Connector extends AbstractConnector {
         constructor(something: unknown) {
            // shitty ioredis types here
            super(something as never);
         }

         async connect(_: ErrorEmitter) {
            return new WadisServerConnector(await wasmServer);
         }
      }

      super({ Connector, maxRetriesPerRequest: null, ...options });
   }
}

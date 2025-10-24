import { WadisServer } from "wadisServer";
import { TextDecoder } from "node:util";
import { beforeEach, describe, expect, test } from "vitest";
import { Wadis } from "index";

describe("wadis server", () => {
   let server: WadisServer;

   beforeEach(async () => {
      server = await WadisServer.new();
   });

   describe("basic commands", () => {
      test("PING works", async () => {
         const resp = await server.call("PING");
         expect(new TextDecoder().decode(resp)).toBe("+PONG\r\n");
      });

      test("SET/GET works", async () => {
         const server = await WadisServer.new({ maxmemory: "50mb" });
         const ok = await server.call("SET", "foo", "bar");
         expect(new TextDecoder().decode(ok)).toBe("+OK\r\n");

         const val = await server.call("GET", "foo");
         expect(new TextDecoder().decode(val)).toBe("$3\r\nbar\r\n");
      });

      test("INCR increments integer keys", async () => {
         const v1 = await server.call("INCR", "counter");
         expect(new TextDecoder().decode(v1)).toBe(":1\r\n");
         const v2 = await server.call("INCR", "counter");
         expect(new TextDecoder().decode(v2)).toBe(":2\r\n");
      });

      test("returns error replies for wrong types", async () => {
         await server.call("SET", "notint", "x");
         const err = await server.call("INCR", "notint");
         const s = new TextDecoder().decode(err);
         expect(s.startsWith("-ERR")).toBe(true);
      });
   });

   describe("lua scripts", () => {
      test("EVAL returns array of values", async () => {
         const script = "return {KEYS[1], ARGV[1]}";
         const resp = await server.call("EVAL", script, "1", "key1", "val1");
         const s = new TextDecoder().decode(resp);
         expect(s.startsWith("*2\r\n")).toBe(true);
         expect(s.includes("$4\r\nkey1\r\n")).toBe(true);
         expect(s.includes("$4\r\nval1\r\n")).toBe(true);
      });

      test("EVAL can SET/GET", async () => {
         const script =
            "redis.call('SET', KEYS[1], ARGV[1]); return redis.call('GET', KEYS[1])";
         const resp = await server.call("EVAL", script, "1", "foo", "bar");
         expect(new TextDecoder().decode(resp)).toBe("$3\r\nbar\r\n");
      });

      test("EVAL returns integer", async () => {
         const script = "return 7";
         const resp = await server.call("EVAL", script, "0");
         expect(new TextDecoder().decode(resp)).toBe(":7\r\n");
      });
   });
});

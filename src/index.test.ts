import { Wadis, WadisServer } from "index";
import { describe, expect, test } from "vitest";

describe("ioredis adapter", () => {
   test("works", async () => {
      const redis = new Wadis();

      await redis.set("foo", "bar");
      const duplicate = redis.duplicate();
      expect(await duplicate.get("foo")).toBe("bar");
      await duplicate.set("foo", "baz");
      expect(await redis.get("foo")).toBe("baz");
      await duplicate.quit();

      expect(await redis.get("foo")).toBe("baz");
   });

   test("pub/sub works", async () => {
      const redis = new Wadis();

      const subscriber = redis.duplicate();
      await subscriber.subscribe("my-channel");

      const messages: string[] = [];
      subscriber.on("message", (_channel, message) => {
         messages.push(message);
      });
      const publisher = redis.duplicate();
      await publisher.publish("my-channel", "hello");
      await publisher.publish("my-channel", "world");

      // wait a tick for messages to be received
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(messages).toEqual(["hello", "world"]);

      await subscriber.quit();
      await publisher.quit();
   });

   test("lua scripting works", async () => {
      const redis = new Wadis();

      const script = `return ARGV[1] .. ARGV[2]`;
      const result = await redis.eval(script, 0, "Hello, ", "world!");

      expect(result).toBe("Hello, world!");
   });

   test("cjson.encode works", async () => {
      const r = new Wadis();
      const res = await r.eval("return cjson.encode({a=1,b='x'})", 0);
      expect(res).toBe('{"a":1,"b":"x"}');
   });

   test("cjson.decode works", async () => {
      const r = new Wadis();
      const res = await r.eval(
         "local t=cjson.decode(ARGV[1]); return t.a+t.b",
         0,
         '{"a":2,"b":3}',
      );
      expect(res).toBe(5);
   });

   test("streams blocking unblocks", async () => {
      const server = await WadisServer.new();
      const c1 = new Wadis({ server });
      const c2 = new Wadis({ server });

      await c1.xgroup("CREATE", "s2", "g2", "0", "MKSTREAM");

      const p = c1.xreadgroup(
         "GROUP",
         "g2",
         "w1",
         "BLOCK" as never,
         2000,
         "COUNT",
         1,
         "STREAMS",
         "s2",
         ">",
      );

      // wait a tick then add
      setTimeout(async () => {
         await c2.xadd("s2", "*", "f", "v");
      }, 100);

      const res = await p;
      expect(Array.isArray(res)).toBe(true);

      await c1.quit();
      await c2.quit();
      await server.terminate();
   });
});

import { Wadis } from "index";
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
});

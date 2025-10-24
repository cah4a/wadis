import { type Job, Queue, QueueEvents, Worker } from "bullmq";
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

   test("cjson.encode works", async () => {
      const r = new Wadis();
      const res = await r.eval("return cjson.encode({a=1,b='x'})", 0);
      expect(res).toBe('{"a":1,"b":"x"}');
   });

   test("cjson.decode works", async () => {
      const r = new Wadis();
      const res = await r.eval("local t=cjson.decode(ARGV[1]); return t.a+t.b", 0, "{\"a\":2,\"b\":3}");
      expect(res).toBe(5);
   });

   test.skip("bullmq job", async () => {
      const redis = new Wadis();

      const myQueue = new Queue("my-queue", { connection: redis });
      const events = new QueueEvents("my-queue", { connection: redis });
      const worker = new Worker(
         "my-queue",
         async (job: Job) => {
            return `Processed ${job.data.name}`;
         },
         { connection: redis },
      );

      const job = await myQueue.add("my-job", { name: "Test Job" });

      await job.waitUntilFinished(events);

      expect(job.returnvalue).toBe("Processed Test Job");

      await worker.close();
      await myQueue.close();
      await events.close();
   });
});

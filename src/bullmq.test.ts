import { type Job, Queue, QueueEvents, Worker } from "bullmq";
import { Wadis, WadisServer } from "index";
import { describe, expect, test } from "vitest";

describe("bullmq", () => {
   test("adding jobs", async () => {
      const redis = new Wadis();
      const myQueue = new Queue("my-queue", { connection: redis });
      const job = await myQueue.add("my-job", { name: "Test Job" });

      expect(await job.getState()).toEqual("waiting");
      await myQueue.close();
      await redis.quit();
   });

   test(
      "processing jobs",
      async () => {
         const redis = new Wadis();
         const myQueue = new Queue("my-queue", { connection: redis });
         const job = await myQueue.add("my-job", { name: "Test Job" });
         const { promise, resolve } = Promise.withResolvers<void>();

         new Worker(
            "my-queue",
            async (job: Job) => {
               setTimeout(resolve, 10);
               return `Processed ${job.data.name}`;
            },
            { connection: redis },
         );

         await promise;
         expect(await job.getState()).toBe("completed");
         expect((await myQueue.getJob(job.id || ""))?.returnvalue).toBe(
            "Processed Test Job",
         );
      },
      { timeout: 1000 },
   );

   test("queue events", async () => {
      const server = await WadisServer.new();
      const redis = new Wadis({
         server,
         maxRetriesPerRequest: null,
      });

      const myQueue = new Queue("my-queue", { connection: redis });
      const myQueueEvents = new QueueEvents("my-queue", { connection: redis });
      await myQueueEvents.waitUntilReady();

      const job = await myQueue.add("my-job", { name: "Test Job" });

      new Worker("my-queue", async (job: Job) => `Processed ${job.data.name}`, {
         connection: redis,
      });

      await job.waitUntilFinished(myQueueEvents, 1000);
      expect(await job.getState()).toBe("completed");
   });
});

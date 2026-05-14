/**
 * Push Notification Queue
 *
 * Persists Firebase push jobs in Redis via BullMQ.
 * Jobs survive process restarts and are retried on transient failures.
 *
 * Split:
 *   Fast path  — DB write + realtime emit (handled by _sendNotificationCore)
 *   Queue path — Firebase call + invalid token cleanup (handled by worker)
 */

import { Queue } from "bullmq";
import { TypeNotification } from "../../_models/notification/type_notification";

export type PushJobData = {
  userId: number;
  notificationId: number | string;
  tokens: string[];
  title: string;
  body: string;
  type: TypeNotification;
  extraData?: Record<string, string | number>;
};

const REDIS_URL = String(process.env.REDIS_URL ?? "redis://127.0.0.1:6379").trim();

const parseRedisUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port) || 6379,
      password: parsed.password || undefined,
      db: parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) || 0 : 0,
    };
  } catch {
    return { host: "127.0.0.1", port: 6379 };
  }
};

const redisConnection = parseRedisUrl(REDIS_URL);

let _queue: Queue<PushJobData> | null = null;

export const getPushQueue = (): Queue<PushJobData> => {
  if (!_queue) {
    _queue = new Queue<PushJobData>("push-notifications", {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5_000, // 5s → 10s → 20s
        },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    });

    _queue.on("error", (err) => {
      console.error("[push-queue] BullMQ queue error:", err);
    });
  }
  return _queue;
};

/**
 * Enqueue a Firebase push job.
 * Returns null if enqueue fails — the push will be silently skipped
 * but the in-app notification (DB record) is already committed.
 */
export const enqueuePushJob = async (data: PushJobData): Promise<void> => {
  try {
    const queue = getPushQueue();
    await queue.add("send-push", data, {
      // Short delay lets the current DB transaction fully commit
      delay: 200,
    });
  } catch (err) {
    console.error("[push-queue] Failed to enqueue push job — push skipped:", err);
  }
};

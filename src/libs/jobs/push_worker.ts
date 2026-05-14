/**
 * Push Notification Worker
 *
 * Processes Firebase push jobs from the BullMQ queue.
 * - Runs inside the same process (no separate worker process needed)
 * - 3 automatic retries with exponential backoff (5s → 10s → 20s)
 * - Cleans invalid tokens from DB after each attempt
 * - Interacts with circuit breaker via sendPushToMultipleUsers
 */

import { Worker, Job } from "bullmq";
import { PushJobData } from "./push_queue";
import { sendPushToMultipleUsers } from "../../useCases/common/push_notification/notification";
import * as userRepository from "../../repository/user/user_repository";
// path: src/repository/user/user_repository.ts (same as notification/add/add.ts uses via module)

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

const obfuscateToken = (token: string): string => {
  if (!token) return "";
  if (token.length <= 12) return "***";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
};

const processPushJob = async (job: Job<PushJobData>): Promise<void> => {
  const { userId, notificationId, tokens, title, body, type, extraData } = job.data;

  if (!tokens?.length) {
    return; // nothing to do
  }

  const pushResult = await sendPushToMultipleUsers(
    title,
    body,
    type,
    notificationId,
    tokens,
    extraData
  );

  // Circuit open → retry will happen automatically via BullMQ backoff
  if ((pushResult as any)?.reason === "CIRCUIT_OPEN") {
    throw new Error("Firebase circuit open — will retry");
  }

  if (!(pushResult as any)?.ok && (pushResult as any)?.reason === "UNKNOWN_ERROR") {
    throw new Error("Firebase unknown error — will retry");
  }

  // Clean up invalid tokens from DB
  const invalidTokenDetails = Array.isArray((pushResult as any)?.invalidTokenDetails)
    ? (pushResult as any).invalidTokenDetails
    : [];
  const strictInvalidDetails = invalidTokenDetails.filter(
    (item: any) => item?.strict === true && String(item?.token ?? "").trim().length > 0
  );
  const strictInvalidTokens =
    strictInvalidDetails.length > 0
      ? strictInvalidDetails.map((item: any) => String(item?.token ?? "").trim())
      : Array.isArray((pushResult as any)?.invalidTokens)
        ? (pushResult as any).invalidTokens
        : [];

  for (const invalidTokenRaw of strictInvalidTokens) {
    const invalidToken = String(invalidTokenRaw ?? "").trim();
    if (!invalidToken) continue;

    try {
      const clearedLegacy = await userRepository.clearUuidIfMatch(userId, invalidToken);
      await userRepository.clearPushSessionTokenIfMatch(userId, invalidToken);

      const detail = strictInvalidDetails.find(
        (item: any) => String(item?.token ?? "").trim() === invalidToken
      );
      const errorCode = String(detail?.code ?? "MULTICAST_INVALID_TOKEN");
      const tokenMasked = obfuscateToken(invalidToken);

      if (clearedLegacy > 0) {
        console.log(
          `🧹 [push-worker] UUID inválido limpiado userId=${userId} reason=${errorCode} token=${tokenMasked}`
        );
      } else {
        console.log(
          `🧹 [push-worker] UUID inválido detectado userId=${userId} reason=${errorCode} token=${tokenMasked}`
        );
      }
    } catch (cleanupErr) {
      console.warn("[push-worker] token cleanup error:", cleanupErr);
    }
  }
};

let _worker: Worker<PushJobData> | null = null;

export const getPushWorkerStatus = (): { running: boolean } => ({
  running: _worker !== null,
});

export const startPushWorker = (): void => {
  if (_worker) return;

  _worker = new Worker<PushJobData>(
    "push-notifications",
    processPushJob,
    {
      connection: redisConnection,
      concurrency: 5,  // up to 5 push jobs in parallel
      limiter: {
        max: 50,        // max 50 jobs per interval
        duration: 1000, // per second — stays well within Firebase limits
      },
    }
  );

  _worker.on("completed", (job) => {
    console.log(
      `[push-worker] job ${job.id} done userId=${job.data.userId} tokens=${job.data.tokens.length}`
    );
  });

  _worker.on("failed", (job, err) => {
    const attemptsMade = job?.attemptsMade ?? "?";
    const attemptsTotal = job?.opts?.attempts ?? "?";
    console.error(
      `[push-worker] job ${job?.id} failed (attempt ${attemptsMade}/${attemptsTotal}) userId=${job?.data?.userId}: ${err.message}`
    );
  });

  _worker.on("error", (err) => {
    console.error("[push-worker] worker error:", err);
  });

  console.log("[push-worker] Started. concurrency=5, queue=push-notifications");
};

export const stopPushWorker = async (): Promise<void> => {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
  console.log("[push-worker] Stopped.");
};

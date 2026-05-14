import crypto from "crypto";
import { Request, Response } from "express";
import { Op, UniqueConstraintError } from "sequelize";
import ContentIdempotency from "../../_models/idempotency/content_idempotency";
import { formatResponse } from "../../useCases/_response/format_response";

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const IDEMPOTENCY_TTL_SECONDS = Math.max(
  60,
  Number(process.env.CONTENT_CREATE_IDEMPOTENCY_TTL_SECONDS ?? 86400) || 86400
);
const IDEMPOTENCY_WAIT_MS = Math.max(
  0,
  Number(process.env.CONTENT_CREATE_IDEMPOTENCY_WAIT_MS ?? 8000) || 8000
);
const IDEMPOTENCY_WAIT_POLL_MS = Math.max(
  100,
  Number(process.env.CONTENT_CREATE_IDEMPOTENCY_WAIT_POLL_MS ?? 250) || 250
);

type ReplayResult = {
  status: number;
  payload: any;
};

type StartResult =
  | { type: "proceed"; recordId: number }
  | { type: "replay"; replay: ReplayResult }
  | { type: "conflict"; message: string; code: number }
  | { type: "error"; message: string; code: number };

type SetupParams = {
  req: Request;
  res: Response;
  endpoint: string;
  payloadForHash: any;
  resolveResourceId?: (responsePayload: any) => string | number | null | undefined;
};

const sleep = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const normalizeHeaderValue = (value: any): string => {
  return String(value ?? "").trim();
};

const parseIdempotencyKeyFromHeaders = (
  req: Request
):
  | { ok: true; key: string | null }
  | { ok: false; code: number; message: string } => {
  const primary = normalizeHeaderValue(req.header("Idempotency-Key"));
  const secondary = normalizeHeaderValue(req.header("X-Idempotency-Key"));

  if (primary && secondary && primary !== secondary) {
    return {
      ok: false,
      code: 409,
      message: "idempotency key mismatch between Idempotency-Key and X-Idempotency-Key",
    };
  }

  const key = primary || secondary;
  if (!key) return { ok: true, key: null };

  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      ok: false,
      code: 400,
      message: `idempotency key is too long (max ${IDEMPOTENCY_KEY_MAX_LENGTH})`,
    };
  }

  return { ok: true, key };
};

const toStableValue = (value: any): any => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => toStableValue(item));
  if (typeof value === "object") {
    const output: Record<string, any> = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        output[key] = toStableValue(value[key]);
      });
    return output;
  }
  return value;
};

const hashPayload = (payload: any): string => {
  const stable = JSON.stringify(toStableValue(payload));
  return crypto.createHash("sha256").update(stable).digest("hex");
};

const ttlExpiryDate = () => new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);

const normalizeResourceId = (
  value: string | number | null | undefined
): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 128) : null;
};

const toReplayResult = (row: any): ReplayResult | null => {
  const responseStatus = Number(row?.response_status ?? 0);
  if (!Number.isFinite(responseStatus) || responseStatus <= 0) return null;
  if (row?.response_body === undefined || row?.response_body === null) return null;
  return {
    status: responseStatus,
    payload: row.response_body,
  };
};

const waitForCompleted = async (params: {
  id: number;
  payloadHash: string;
}): Promise<StartResult> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < IDEMPOTENCY_WAIT_MS) {
    const row = await ContentIdempotency.findByPk(params.id);
    if (!row) {
      return {
        type: "conflict",
        code: 409,
        message: "idempotency request state not found",
      };
    }

    const payloadHash = String((row as any)?.payload_hash ?? "");
    if (payloadHash && payloadHash !== params.payloadHash) {
      return {
        type: "conflict",
        code: 409,
        message: "idempotency key already used with different payload",
      };
    }

    const replay = toReplayResult(row);
    if (String((row as any)?.status ?? "") === "completed" && replay) {
      return { type: "replay", replay };
    }

    await sleep(IDEMPOTENCY_WAIT_POLL_MS);
  }

  return {
    type: "conflict",
    code: 409,
    message: "idempotency request is still processing, retry shortly",
  };
};

const startWithKey = async (params: {
  userId: number;
  endpoint: string;
  idempotencyKey: string;
  payloadHash: string;
}): Promise<StartResult> => {
  const where = {
    user_id: params.userId,
    endpoint: params.endpoint,
    idempotency_key: params.idempotencyKey,
  } as const;

  const createProcessingRow = async () => {
    return ContentIdempotency.create({
      ...where,
      payload_hash: params.payloadHash,
      status: "processing",
      response_status: null,
      response_body: null,
      resource_id: null,
      expires_at: ttlExpiryDate(),
    });
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const created = await createProcessingRow();
      return { type: "proceed", recordId: Number((created as any)?.id) };
    } catch (error: any) {
      if (!(error instanceof UniqueConstraintError)) {
        return {
          type: "error",
          code: 500,
          message: error?.message ?? "unable to initialize idempotency state",
        };
      }
    }

    const existing = await ContentIdempotency.findOne({ where });
    if (!existing) continue;

    const payloadHash = String((existing as any)?.payload_hash ?? "");
    const now = new Date();
    const expiresAt = (existing as any)?.expires_at ? new Date((existing as any).expires_at) : null;
    const isExpired = !!expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now;

    if (isExpired) {
      const [claimed] = await ContentIdempotency.update(
        {
          payload_hash: params.payloadHash,
          status: "processing",
          response_status: null,
          response_body: null,
          resource_id: null,
          expires_at: ttlExpiryDate(),
        },
        {
          where: {
            id: Number((existing as any)?.id),
            expires_at: { [Op.lte]: now },
          },
        }
      );
      if (Number(claimed) > 0) {
        return { type: "proceed", recordId: Number((existing as any)?.id) };
      }
      continue;
    }

    if (payloadHash && payloadHash !== params.payloadHash) {
      return {
        type: "conflict",
        code: 409,
        message: "idempotency key already used with different payload",
      };
    }

    const replay = toReplayResult(existing);
    if (String((existing as any)?.status ?? "") === "completed" && replay) {
      return { type: "replay", replay };
    }

    return await waitForCompleted({
      id: Number((existing as any)?.id),
      payloadHash: params.payloadHash,
    });
  }

  return {
    type: "error",
    code: 500,
    message: "unable to establish idempotency state",
  };
};

const finalizeRecord = async (params: {
  recordId: number;
  status: number;
  payload: any;
  resourceId: string | null;
}) => {
  await ContentIdempotency.update(
    {
      status: "completed",
      response_status: params.status,
      response_body: params.payload,
      resource_id: params.resourceId,
      expires_at: ttlExpiryDate(),
    },
    { where: { id: params.recordId } }
  );
};

const attachCompletionCapture = (params: {
  res: Response;
  recordId: number;
  resolveResourceId?: (responsePayload: any) => string | number | null | undefined;
}) => {
  const { res } = params;
  const originalJson = res.json.bind(res);
  let finalized = false;

  (res as any).json = ((payload: any) => {
    if (!finalized) {
      finalized = true;
      const statusCode = Number((res as any)?.statusCode ?? 200) || 200;
      const resourceIdRaw = params.resolveResourceId
        ? params.resolveResourceId(payload)
        : null;
      const resourceId = normalizeResourceId(resourceIdRaw);

      void finalizeRecord({
        recordId: params.recordId,
        status: statusCode,
        payload,
        resourceId,
      }).catch((error) => {
        console.warn("[idempotency] failed to finalize response snapshot", error);
      });
    }
    return originalJson(payload);
  }) as any;
};

export const applyCreateContentIdempotency = async (
  params: SetupParams
): Promise<boolean> => {
  const { req, res } = params;
  res.set("Idempotency-Replayed", "false");

  const userId = Number((req as any)?.userId ?? 0);
  if (!Number.isFinite(userId) || userId <= 0) return true;

  const parsedKey = parseIdempotencyKeyFromHeaders(req);
  if (!parsedKey.ok) {
    formatResponse({
      res,
      success: false,
      code: parsedKey.code,
      message: parsedKey.message,
    });
    return false;
  }

  if (!parsedKey.key) return true;

  const payloadHash = hashPayload(params.payloadForHash ?? {});
  const started = await startWithKey({
    userId,
    endpoint: params.endpoint,
    idempotencyKey: parsedKey.key,
    payloadHash,
  });

  if (started.type === "replay") {
    res.set("Idempotency-Replayed", "true");
    res.status(started.replay.status).json(started.replay.payload);
    return false;
  }

  if (started.type === "conflict") {
    formatResponse({
      res,
      success: false,
      code: started.code,
      message: started.message,
    });
    return false;
  }

  if (started.type === "error") {
    formatResponse({
      res,
      success: false,
      code: started.code,
      message: started.message,
    });
    return false;
  }

  attachCompletionCapture({
    res,
    recordId: started.recordId,
    resolveResourceId: params.resolveResourceId,
  });
  return true;
};

export default {
  applyCreateContentIdempotency,
};

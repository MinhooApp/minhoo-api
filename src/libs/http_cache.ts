import { createHash } from "crypto";
import { Request, Response } from "express";

type CacheVisibility = "public" | "private";

type CacheOptions = {
  visibility?: CacheVisibility;
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds?: number;
  staleIfErrorSeconds?: number;
  mustRevalidate?: boolean;
};

const buildWeakEtag = (payload: any) => {
  const hash = createHash("sha1").update(JSON.stringify(payload ?? null)).digest("hex");
  return `W/"${hash}"`;
};

const isEtagFresh = (req: Request, etag: string) => {
  const incoming = String(req.headers["if-none-match"] ?? "").trim();
  if (!incoming) return false;
  if (incoming === "*") return true;
  return incoming
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(etag);
};

export const setCacheControl = (res: Response, options: CacheOptions) => {
  const directives = [
    options.visibility ?? "public",
    `max-age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];

  if (options.staleWhileRevalidateSeconds && options.staleWhileRevalidateSeconds > 0) {
    directives.push(
      `stale-while-revalidate=${Math.floor(options.staleWhileRevalidateSeconds)}`
    );
  }

  if (options.staleIfErrorSeconds && options.staleIfErrorSeconds > 0) {
    directives.push(`stale-if-error=${Math.floor(options.staleIfErrorSeconds)}`);
  }

  if (options.mustRevalidate) directives.push("must-revalidate");

  res.set("Cache-Control", directives.join(", "));
  res.set("Vary", "Accept-Encoding");
};

export const respondNotModifiedIfFresh = (
  req: Request,
  res: Response,
  payload: any
) => {
  const etag = buildWeakEtag(payload);
  res.set("ETag", etag);
  if (!isEtagFresh(req, etag)) return false;
  res.status(304).end();
  return true;
};

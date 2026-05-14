import { Response } from "express";

type UnifiedBodyParams = {
  items?: any[];
  users?: any[];
  count?: number;
  page?: number;
  size?: number;
  next_cursor?: string | null;
  extras?: Record<string, any>;
};

const toCount = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const toPage = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const toSize = (value: any, fallback = 20) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

export const sendUnifiedSuccess = (
  res: Response,
  params: UnifiedBodyParams = {}
) => {
  const items = Array.isArray(params.items) ? params.items : [];
  const users = Array.isArray(params.users) ? params.users : [];
  const count = toCount(params.count ?? items.length ?? users.length);
  const page = toPage(params.page ?? 0);
  const size = toSize(params.size ?? 20);
  const nextCursor =
    params.next_cursor === undefined ? null : params.next_cursor;
  const extras =
    params.extras && typeof params.extras === "object" ? params.extras : {};

  return res.status(200).json({
    header: {
      success: true,
      messages: [],
    },
    body: {
      ...extras,
      items,
      users,
      count,
      page,
      size,
      next_cursor: nextCursor,
    },
  });
};

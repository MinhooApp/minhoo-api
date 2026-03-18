import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import admin from "firebase-admin";
import * as followerRepo from "../../../repository/follower/follower_repository";

const attachFollowCountAliases = (entity: any, followersCount: number, followingCount: number) => {
  if (!entity) return;

  const fields = {
    followers_count: followersCount,
    followings_count: followingCount,
    following_count: followingCount,
    followersCount,
    followingsCount: followingCount,
    followingCount,
  };

  if (typeof entity.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      entity.setDataValue(key, value);
    });
    return;
  }

  Object.assign(entity, fields);
};

export const workers = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 5 } = req.query;
    const workers: any = await repository.workers(page, size, req.userId);
    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: workers.count,
        workers: workers.rows,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const worker = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const worker: any = await repository.worker(id ?? req.userId, req.userId);
    let counts: { followersCount: number; followingCount: number } | null = null;

    const targetUserId = Number((worker as any)?.userId ?? (worker as any)?.personal_data?.id);
    if (Number.isFinite(targetUserId) && targetUserId > 0) {
      counts = await followerRepo.getCounts(targetUserId);
      attachFollowCountAliases(worker, counts.followersCount, counts.followingCount);
      attachFollowCountAliases(
        (worker as any)?.personal_data,
        counts.followersCount,
        counts.followingCount
      );
    }

    return formatResponse({
      res: res,
      success: true,
      body: {
        worker: worker,
        counts: counts
          ? {
              followersCount: counts.followersCount,
              followingCount: counts.followingCount,
              followers_count: counts.followersCount,
              followings_count: counts.followingCount,
              following_count: counts.followingCount,
            }
          : null,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const ids = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const ids: any = await repository.tokensByNewService(id, req.userId);
    return formatResponse({
      res: res,
      success: true,
      body: {
        ids: ids,
      },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

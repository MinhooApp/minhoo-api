import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import * as savedRepository from "../../../repository/saved/saved_repository";

const normalizeUserId = (value: any): number | null => {
  const userId = Number(value);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return userId;
};

const setSavedFlag = (post: any, isSaved: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_saved", isSaved);
    return;
  }
  post.is_saved = isSaved;
};

const setSavedCount = (post: any, count: number) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("saved_count", count);
    post.setDataValue("savedCount", count);
    return;
  }
  post.saved_count = count;
  post.savedCount = count;
};

const attachSavedFlags = async (viewerIdRaw: any, posts: any[]) => {
  if (!Array.isArray(posts) || !posts.length) return;

  const viewerId = normalizeUserId(viewerIdRaw);
  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const countMap = await savedRepository.getSavedCountsMap(postIds);
  posts.forEach((post: any) => {
    const postId = Number(post?.id);
    setSavedCount(post, countMap.get(postId) ?? 0);
  });

  if (!viewerId) {
    posts.forEach((post: any) => setSavedFlag(post, false));
    return;
  }

  const savedSet = await savedRepository.getSavedPostIdSet(viewerId, postIds);
  posts.forEach((post: any) => {
    setSavedFlag(post, savedSet.has(Number(post?.id)));
  });
};

export const gets = async (req: Request, res: Response) => {
  try {
    const { page = 0, size = 10 } = req.query;
    const posts = await repository.gets(page, size, req.userId);
    await attachSavedFlags(req.userId, posts.rows);

    return formatResponse({
      res: res,
      success: true,
      body: {
        page: +page,
        size: +size,
        count: posts.count,
        posts: posts.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const post = await repository.get(id, req.userId);
    if (post) {
      const postId = Number(post.id);
      const saveCount = await savedRepository.countByPostId(postId);
      setSavedCount(post, saveCount);

      const viewerId = normalizeUserId(req.userId);
      if (!viewerId) {
        setSavedFlag(post, false);
      } else {
        const isSaved = await savedRepository.isPostSavedByUser(
          viewerId,
          postId
        );
        setSavedFlag(post, isSaved);
      }
    }

    return formatResponse({ res: res, success: true, body: { post: post } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

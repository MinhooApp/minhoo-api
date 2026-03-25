import Comment from "../../_models/comment/comment";
import Post from "../../_models/post/post";
import UserBLock from "../../_models/block/block";
import CommentReport from "../../_models/comment/comment_report";
import { Op, UniqueConstraintError } from "sequelize";

const COMMENT_REPORT_AUTO_DELETE_THRESHOLD = Math.max(
  15,
  Number(process.env.COMMENT_REPORT_AUTO_DELETE_THRESHOLD ?? 15) || 15
);

const isMissingTableError = (error: any) => {
  const code = String(error?.original?.code ?? error?.code ?? "").toUpperCase();
  const message = String(error?.original?.sqlMessage ?? error?.message ?? "").toLowerCase();
  return code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist");
};

/**
 * Verifica si existe bloqueo entre A y B (en ambos sentidos).
 * - Si alguno no es válido -> false (para no romper producción)
 */
const isBlockedBetween = async (a: any, b: any) => {
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || A <= 0) return false;
  if (!Number.isFinite(B) || B <= 0) return false;

  const found = await UserBLock.findOne({
    where: {
      [Op.or]: [
        { blocker_id: A, blocked_id: B },
        { blocker_id: B, blocked_id: A },
      ],
    },
  });

  return !!found;
};

/**
 * ✅ CREATE COMMENT
 * - No permite comentar si el dueño del post y el usuario están bloqueados (en ambos sentidos)
 * - Si meId no viene, intenta usar body.userId (compat)
 */
export const add = async (body: any, meId: any = -1) => {
  const me = Number(meId) > 0 ? Number(meId) : Number(body?.userId);

  // Si no hay postId o no hay usuario, dejamos pasar (compat)
  if (!body?.postId || !Number.isFinite(me) || me <= 0) {
    return await Comment.create(body);
  }

  const post = await Post.findByPk(body.postId, { attributes: ["id", "userId"] });
  if (!post) return null;

  const ownerId = Number((post as any).userId);
  const blocked = await isBlockedBetween(me, ownerId);

  // ✅ Si hay bloqueo, NO crear comment (no rompemos response)
  if (blocked) return null;

  return await Comment.create(body);
};

export const all = async () => {
  return await Comment.findAll();
};

export const gets = async () => {
  // ✅ NO filtramos por bloqueos: comentarios viejos se quedan visibles
  return await Comment.findAll({ where: { is_delete: false } });
};

export const getOne = async (id: any) => {
  return await Comment.findOne({ where: { id } });
};

export const get = async (id: any) => {
  return await Comment.findOne({ where: { id, is_delete: false } });
};

export const update = async (id: any, body: any) => {
  const commentTemp = await Comment.findByPk(id);
  const comment = await commentTemp?.update(body);
  return [comment];
};

export const deletecomment = async (id: any) => {
  return await Comment.update({ is_delete: true }, { where: { id } });
};

export const reportComment = async ({
  commentIdRaw,
  reporterIdRaw,
  reason,
  details,
}: {
  commentIdRaw: any;
  reporterIdRaw: any;
  reason: string;
  details?: string | null;
}) => {
  const commentId = Number(commentIdRaw);
  const reporterId = Number(reporterIdRaw);
  if (!Number.isFinite(commentId) || commentId <= 0) {
    return { notFound: true };
  }
  if (!Number.isFinite(reporterId) || reporterId <= 0) {
    return { invalidReporter: true };
  }

  const sequelize = (Comment as any).sequelize;
  const normalizedDetails = String(details ?? "").trim().slice(0, 4000) || null;

  return sequelize
    .transaction(async (transaction: any) => {
      const comment = await Comment.findOne({
        where: { id: commentId, is_delete: false },
        attributes: ["id", "userId", "is_delete"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (!comment) {
        return { notFound: true };
      }

      const ownerId = Number((comment as any)?.userId ?? 0);
      if (ownerId > 0 && ownerId === reporterId) {
        return { selfReport: true };
      }

      const existing = await CommentReport.findOne({
        where: { commentId, reporterId },
        attributes: ["id"],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      let alreadyReported = false;
      if (!existing) {
        try {
          await CommentReport.create(
            {
              commentId,
              reporterId,
              reason,
              details: normalizedDetails,
            },
            { transaction }
          );
        } catch (error: any) {
          if (error instanceof UniqueConstraintError) {
            alreadyReported = true;
          } else {
            throw error;
          }
        }
      } else {
        alreadyReported = true;
      }

      const reportsCount = await CommentReport.count({
        where: { commentId },
        distinct: true,
        col: "reporterId",
        transaction,
      });

      const shouldAutoDelete =
        Number(reportsCount) >= COMMENT_REPORT_AUTO_DELETE_THRESHOLD &&
        !Boolean((comment as any)?.is_delete);

      let autoDeleted = false;
      if (shouldAutoDelete) {
        await Comment.update(
          {
            is_delete: true,
            deleted_date: new Date(new Date().toUTCString()),
          },
          {
            where: { id: commentId },
            transaction,
          }
        );
        autoDeleted = true;
      }

      return {
        notFound: false,
        invalidReporter: false,
        selfReport: false,
        alreadyReported,
        reportsCount: Number(reportsCount) || 0,
        threshold: COMMENT_REPORT_AUTO_DELETE_THRESHOLD,
        autoDeleted,
        commentId,
        ownerId,
      };
    })
    .catch((error: any) => {
      if (isMissingTableError(error)) return { storageMissing: true };
      throw error;
    });
};

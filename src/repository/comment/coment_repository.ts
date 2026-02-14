import Comment from "../../_models/comment/comment";
import Post from "../../_models/post/post";
import UserBLock from "../../_models/block/block";
import { Op } from "sequelize";

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

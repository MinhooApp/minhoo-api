import { Op } from "sequelize";
import UserBlock from "../../_models/block/block";

export class BlockUserRepository {
  static async blockUser(blockerId: number, blockedId: number) {
    if (blockerId === blockedId) {
      throw new Error("You cannot block yourself");
    }

    const exists = await UserBlock.findOne({
      where: { blocker_id: blockerId, blocked_id: blockedId },
    });

    if (exists) return exists;

    return UserBlock.create({
      blocker_id: blockerId,
      blocked_id: blockedId,
    });
  }

  static async unblockUser(blockerId: number, blockedId: number) {
    return UserBlock.destroy({
      where: { blocker_id: blockerId, blocked_id: blockedId },
    });
  }

  static async getBlockedIdsByMe(userId: number): Promise<number[]> {
    const rows = await UserBlock.findAll({
      where: { blocker_id: userId },
      attributes: ["blocked_id"],
    });

    return rows.map((r: any) => Number(r.blocked_id)).filter(Number.isFinite);
  }

  static async getIdsWhoBlockedMe(userId: number): Promise<number[]> {
    const rows = await UserBlock.findAll({
      where: { blocked_id: userId },
      attributes: ["blocker_id"],
    });

    return rows.map((r: any) => Number(r.blocker_id)).filter(Number.isFinite);
  }

  static async getAllBlockedIds(userId: number): Promise<number[]> {
    const [a, b] = await Promise.all([
      this.getBlockedIdsByMe(userId),
      this.getIdsWhoBlockedMe(userId),
    ]);

    return Array.from(new Set([...a, ...b]));
  }

  static async isBlockedEitherWay(userA: number, userB: number): Promise<boolean> {
    const found = await UserBlock.findOne({
      where: {
        [Op.or]: [
          { blocker_id: userA, blocked_id: userB },
          { blocker_id: userB, blocked_id: userA },
        ],
      },
      attributes: ["id"],
    });

    return !!found;
  }
}

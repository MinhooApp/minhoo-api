// src/repository/user/block_user_repository.ts

// ✅ AJUSTA ESTE IMPORT según tu proyecto (prisma/db)
import { db } from "../../_db"; // <-- cámbialo al que uses

export class BlockUserRepository {
  /**
   * Crear bloqueo: blockerId bloquea a blockedId
   * Debe ser idempotente: si ya existe, no falla.
   */
  static async blockUser(blockerId: number, blockedId: number) {
    if (blockerId === blockedId) {
      throw new Error("You cannot block yourself");
    }

    // si ya existe, no duplicar
    const exists = await db.user_block.findFirst({
      where: { blocker_id: blockerId, blocked_id: blockedId },
    });

    if (exists) return exists;

    return db.user_block.create({
      data: {
        blocker_id: blockerId,
        blocked_id: blockedId,
      },
    });
  }

  /**
   * Desbloquear
   */
  static async unblockUser(blockerId: number, blockedId: number) {
    return db.user_block.deleteMany({
      where: { blocker_id: blockerId, blocked_id: blockedId },
    });
  }

  /**
   * Lista de IDs que ESTE usuario bloqueó
   */
  static async getBlockedIdsByMe(userId: number): Promise<number[]> {
    const rows = await db.user_block.findMany({
      where: { blocker_id: userId },
      select: { blocked_id: true },
    });

    return rows.map((r: any) => r.blocked_id);
  }

  /**
   * Lista de IDs que ME bloquearon a mí
   */
  static async getIdsWhoBlockedMe(userId: number): Promise<number[]> {
    const rows = await db.user_block.findMany({
      where: { blocked_id: userId },
      select: { blocker_id: true },
    });

    return rows.map((r: any) => r.blocker_id);
  }

  /**
   * IDs bloqueados en ambos sentidos: (yo bloqueé) + (me bloquearon)
   */
  static async getAllBlockedIds(userId: number): Promise<number[]> {
    const [a, b] = await Promise.all([
      this.getBlockedIdsByMe(userId),
      this.getIdsWhoBlockedMe(userId),
    ]);

    return Array.from(new Set([...a, ...b]));
  }

  /**
   * Verifica si existe bloqueo en cualquier sentido entre dos users
   */
  static async isBlockedEitherWay(userA: number, userB: number): Promise<boolean> {
    const found = await db.user_block.findFirst({
      where: {
        OR: [
          { blocker_id: userA, blocked_id: userB },
          { blocker_id: userB, blocked_id: userA },
        ],
      },
      select: { id: true },
    });

    return !!found;
  }
}

// src/repository/user/block_user_helper.ts
import { BlockUserRepository } from "./block_user_repository";

/**
 * Helper para filtrar resultados en cualquier repository.
 * Retorna un objeto con:
 * - blockedIds: ids bloqueados en ambos sentidos
 * - whereNotBlocked: condición lista para usar en queries por user_id
 */
export class BlockUserHelper {
  static async getBlockedContext(myUserId: number) {
    const blockedIds = await BlockUserRepository.getAllBlockedIds(myUserId);

    return {
      blockedIds,
      /**
       * Ejemplo de uso:
       * where: { user_id: { notIn: blockedIds } }
       */
      whereNotBlockedByUserId: blockedIds.length
        ? { notIn: blockedIds }
        : undefined,
    };
  }

  /**
   * Guardia para endpoints tipo "ver perfil" o "ver post por id"
   * Si hay bloqueo -> lanzar error para que el controller responda 404/403.
   */
  static async assertNotBlocked(myUserId: number, targetUserId: number) {
    const blocked = await BlockUserRepository.isBlockedEitherWay(myUserId, targetUserId);
    if (blocked) {
      const err: any = new Error("User not available");
      err.status = 404; // o 403 si prefieres
      throw err;
    }
  }
}

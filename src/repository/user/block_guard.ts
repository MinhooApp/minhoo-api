// src/repository/user/block_guard.ts
import UserBLock from "../../_models/block/block";

export const assertNotBlocked = async (meId: any, targetId: any) => {
  if (meId === -1 || meId === null || meId === undefined) return;

  const blocked = await UserBLock.findOne({
    where: {
      // bloqueo en ambos sentidos
      // (A bloquea B) OR (B bloquea A)
      // Sequelize interpreta OR
      $or: [
        { blocker_id: meId, blocked_id: targetId },
        { blocker_id: targetId, blocked_id: meId },
      ],
    } as any,
  });

  if (blocked) {
    const err: any = new Error("User not available");
    err.status = 404; // o 403
    throw err;
  }
};

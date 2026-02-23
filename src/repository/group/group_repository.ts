import Group from "../../_models/chat/group";
import GroupInvite from "../../_models/chat/group_invite";
import GroupJoinRequest from "../../_models/chat/group_join_request";
import GroupMember from "../../_models/chat/group_member";
import Chat from "../../_models/chat/chat";
import Chat_User from "../../_models/chat/chat_user";
import Message from "../../_models/chat/message";
import User from "../../_models/user/user";
import { randomBytes } from "crypto";
import { Op } from "sequelize";
import sequelize from "../../_db/connection";

export const MAX_GROUPS_PER_OWNER = 10;
const INVITE_CODE_LENGTH = 8;
const INVITE_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type CreateGroupPayload = {
  ownerUserId: number;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  maxMembers: number;
  joinMode: "private" | "public_with_approval";
  writeMode: "all_members" | "admins_only";
};

export type CreateInvitePayload = {
  groupId: number;
  createdByUserId: number;
  expiresAt: Date | null;
  maxUses: number;
};

export type GroupActorRole = "owner" | "admin" | "member" | "none";

const generateInviteCode = (length = INVITE_CODE_LENGTH) => {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += INVITE_CODE_CHARSET[bytes[i] % INVITE_CODE_CHARSET.length];
  }
  return code;
};

const normalizeInviteCode = (value: any) =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const groupTxOptions = (transaction?: any) => (transaction ? { transaction } : {});

const lockIfTx = (transaction?: any) =>
  transaction ? { lock: transaction.LOCK.UPDATE } : {};

const ensureChatLinksForActiveMembers = async (
  groupId: number,
  chatId: number,
  transaction?: any
) => {
  const activeMembers = await GroupMember.findAll({
    where: {
      groupId,
      isActive: true,
    },
    attributes: ["userId"],
    raw: true,
    ...groupTxOptions(transaction),
  });

  const userIds = Array.from(
    new Set(
      (activeMembers as any[])
        .map((row) => Number((row as any).userId))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  if (!userIds.length) return;

  const now = new Date();
  await Chat_User.bulkCreate(
    userIds.map((userId) => ({
      userId,
      chatId,
      pinnedAt: null,
      pinnedOrder: null,
      createdAt: now,
      updatedAt: now,
    })),
    {
      ignoreDuplicates: true,
      ...groupTxOptions(transaction),
    }
  );
};

export const ensureGroupChatRoom = async (groupId: number, transaction?: any) => {
  const group = await Group.findOne({
    where: {
      id: groupId,
      isActive: true,
    },
    ...groupTxOptions(transaction),
    ...lockIfTx(transaction),
  });
  if (!group) return null;

  const ownerUserId = toPositiveInt((group as any).ownerUserId);
  if (ownerUserId) {
    const ownerMembership = await GroupMember.findOne({
      where: {
        groupId,
        userId: ownerUserId,
      },
      ...groupTxOptions(transaction),
      ...lockIfTx(transaction),
    });
    if (!ownerMembership) {
      await GroupMember.create(
        {
          groupId,
          userId: ownerUserId,
          role: "owner",
          isActive: true,
        },
        groupTxOptions(transaction)
      );
    } else if (
      String((ownerMembership as any).role ?? "owner") !== "owner" ||
      !(ownerMembership as any).isActive
    ) {
      await ownerMembership.update(
        { role: "owner", isActive: true },
        groupTxOptions(transaction)
      );
    }
  }

  let chatId = toPositiveInt((group as any).chatId);
  let chat: any = null;

  if (chatId) {
    chat = await Chat.findByPk(chatId, {
      ...groupTxOptions(transaction),
      ...lockIfTx(transaction),
    });
  }

  if (!chat) {
    chat = await Chat.create(
      {
        deletedBy: 0,
      },
      groupTxOptions(transaction)
    );
    chatId = Number((chat as any).id);
    await group.update({ chatId }, groupTxOptions(transaction));
  } else if (Number((chat as any).deletedBy ?? 0) === -1) {
    await chat.update({ deletedBy: 0 }, groupTxOptions(transaction));
    chatId = Number((chat as any).id);
  }

  if (!chatId) return null;

  await ensureChatLinksForActiveMembers(groupId, chatId, transaction);
  return chatId;
};

export const attachUserToGroupChat = async (
  groupId: number,
  userId: number,
  transaction?: any
) => {
  const uid = toPositiveInt(userId);
  if (!uid) return null;

  const chatId = await ensureGroupChatRoom(groupId, transaction);
  if (!chatId) return null;

  const now = new Date();
  await Chat_User.bulkCreate(
    [
      {
        userId: uid,
        chatId,
        pinnedAt: null,
        pinnedOrder: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    {
      ignoreDuplicates: true,
      ...groupTxOptions(transaction),
    }
  );
  return chatId;
};

export const detachUserFromGroupChat = async (
  groupId: number,
  userId: number,
  transaction?: any
) => {
  const uid = toPositiveInt(userId);
  if (!uid) return;

  const group = await Group.findByPk(groupId, {
    attributes: ["id", "chatId"],
    ...groupTxOptions(transaction),
  });
  if (!group) return;

  const chatId = toPositiveInt((group as any).chatId);
  if (!chatId) return;

  await Chat_User.destroy({
    where: {
      userId: uid,
      chatId,
    },
    ...groupTxOptions(transaction),
  });
};

export const getOwnerUser = async (userId: number) => {
  return User.findByPk(userId, {
    attributes: ["id", "username", "name", "last_name", "available", "is_deleted"],
  });
};

export const countActiveByOwner = async (ownerUserId: number) => {
  return Group.count({
    where: {
      ownerUserId,
      isActive: true,
    },
  });
};

export const createGroup = async (payload: CreateGroupPayload) => {
  const owner = await getOwnerUser(payload.ownerUserId);
  if (!owner) return null;

  const ownerUsernameRaw = String((owner as any)?.username ?? "").trim();
  const ownerUsername = ownerUsernameRaw || null;

  return Group.create({
    ownerUserId: payload.ownerUserId,
    ownerUsername,
    name: payload.name,
    description: payload.description,
    avatarUrl: payload.avatarUrl,
    maxMembers: payload.maxMembers,
    joinMode: payload.joinMode,
    writeMode: payload.writeMode,
    isActive: true,
  });
};

export const ensureOwnerMember = async (groupId: number, ownerUserId: number) => {
  const existing = await GroupMember.findOne({
    where: {
      groupId,
      userId: ownerUserId,
    },
  });

  if (!existing) {
    const created = await GroupMember.create({
      groupId,
      userId: ownerUserId,
      role: "owner",
      isActive: true,
    });
    await attachUserToGroupChat(groupId, ownerUserId);
    return created;
  }

  await existing.update({
    role: "owner",
    isActive: true,
  });
  await attachUserToGroupChat(groupId, ownerUserId);
  return existing;
};

export const myGroups = async (ownerUserId: number) => {
  return Group.findAll({
    where: {
      ownerUserId,
      isActive: true,
    },
    include: [
      {
        model: User,
        as: "owner",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
    order: [["id", "DESC"]],
  });
};

export const getActiveGroupById = async (groupId: number) => {
  return Group.findOne({
    where: {
      id: groupId,
      isActive: true,
    },
    include: [
      {
        model: User,
        as: "owner",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
  });
};

export const getOwnedActiveGroup = async (ownerUserId: number, groupId: number) => {
  return Group.findOne({
    where: {
      id: groupId,
      ownerUserId,
      isActive: true,
    },
    include: [
      {
        model: User,
        as: "owner",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
  });
};

export const deactivateOwnedGroup = async (ownerUserId: number, groupId: number) => {
  const group = await getOwnedActiveGroup(ownerUserId, groupId);
  if (!group) return null;
  await group.update({ isActive: false });
  const chatId = toPositiveInt((group as any).chatId);
  if (chatId) {
    await Chat_User.destroy({ where: { chatId } });
    await Chat.update({ deletedBy: -1 }, { where: { id: chatId } });
  }
  return group;
};

export const deactivateOwnedGroupAndRelations = async (
  ownerUserId: number,
  groupId: number
) => {
  const transaction = await sequelize.transaction();
  try {
    const group = await Group.findOne({
      where: {
        id: groupId,
        ownerUserId,
        isActive: true,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!group) {
      await transaction.rollback();
      return null;
    }

    await group.update({ isActive: false }, { transaction });
    await GroupMember.update(
      { isActive: false },
      {
        where: { groupId, isActive: true },
        transaction,
      }
    );
    await GroupInvite.update(
      { isActive: false },
      {
        where: { groupId, isActive: true },
        transaction,
      }
    );
    await GroupJoinRequest.update(
      {
        status: "rejected",
        reviewedAt: new Date(),
        reviewedByUserId: ownerUserId,
        note: "group deactivated",
      },
      {
        where: { groupId, status: "pending" },
        transaction,
      }
    );

    const chatId = toPositiveInt((group as any).chatId);
    if (chatId) {
      await Chat_User.destroy({
        where: { chatId },
        transaction,
      });
      await Chat.update(
        { deletedBy: -1 },
        {
          where: { id: chatId },
          transaction,
        }
      );
    }

    await transaction.commit();
    return group;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

export const updateOwnedGroup = async (
  ownerUserId: number,
  groupId: number,
  payload: Partial<{
    name: string;
    description: string | null;
    avatarUrl: string | null;
  }>
) => {
  const group = await getOwnedActiveGroup(ownerUserId, groupId);
  if (!group) return null;
  await group.update(payload);
  return group;
};

export const getAnyMembership = async (groupId: number, userId: number) => {
  return GroupMember.findOne({
    where: {
      groupId,
      userId,
    },
  });
};

export const getActorRoleInGroup = async (
  groupId: number,
  userId: number
): Promise<GroupActorRole> => {
  const group = await getActiveGroupById(groupId);
  if (!group) return "none";

  if (Number((group as any).ownerUserId) === userId) return "owner";

  const membership = await getActiveMembership(groupId, userId);
  if (!membership) return "none";

  const role = String((membership as any).role ?? "member").toLowerCase();
  if (role === "admin") return "admin";
  if (role === "owner") return "owner";
  return "member";
};

export const isActorAdminInGroup = async (groupId: number, userId: number) => {
  const role = await getActorRoleInGroup(groupId, userId);
  return role === "owner" || role === "admin";
};

export const getGroupAdminUserIds = async (groupId: number) => {
  const group = await getActiveGroupById(groupId);
  if (!group) return [];

  const ownerUserId = Number((group as any).ownerUserId);
  const adminMembers = await GroupMember.findAll({
    where: {
      groupId,
      isActive: true,
      role: {
        [Op.in]: ["owner", "admin"],
      },
    },
    attributes: ["userId"],
  });

  const ids = new Set<number>();
  if (ownerUserId > 0) ids.add(ownerUserId);
  for (const row of adminMembers as any[]) {
    const id = Number((row as any).userId);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
};

export const getActiveMemberUserIds = async (groupId: number) => {
  const members = await GroupMember.findAll({
    where: {
      groupId,
      isActive: true,
    },
    attributes: ["userId"],
    raw: true,
  });

  return Array.from(
    new Set(
      (members as any[])
        .map((row) => Number((row as any).userId))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
};

export const getGroupAccessSnapshot = async (groupId: number, userId?: number | null) => {
  const group = await getActiveGroupById(groupId);
  if (!group) return null;
  const chatId = await ensureGroupChatRoom(groupId);
  if (chatId && Number((group as any).chatId ?? 0) !== chatId) {
    (group as any).chatId = chatId;
  }

  const uid = Number(userId);
  const hasUser = Number.isFinite(uid) && uid > 0;

  let role: GroupActorRole = "none";
  let isMember = false;
  let isAdmin = false;

  if (hasUser) {
    role = await getActorRoleInGroup(groupId, uid);
    isMember = role !== "none";
    isAdmin = role === "owner" || role === "admin";
  }

  const joinMode = String((group as any).joinMode ?? "public_with_approval");
  const writeMode = String((group as any).writeMode ?? "all_members");
  const isPrivate = joinMode === "private";

  const canViewChat = isPrivate ? isMember : true;
  const canInteract = isMember && (writeMode === "all_members" || isAdmin);

  return {
    group,
    policy: {
      chat_id: chatId ?? null,
      join_mode: joinMode,
      write_mode: writeMode,
      is_private: isPrivate,
      is_member: isMember,
      is_admin: isAdmin,
      role,
      can_view_chat: canViewChat,
      can_interact: canInteract,
    },
  };
};

export const countActiveMembers = async (groupId: number) => {
  return GroupMember.count({
    where: {
      groupId,
      isActive: true,
    },
  });
};

export const getChatLastReadMessageId = async (chatId: number, userId: number) => {
  const cid = toPositiveInt(chatId);
  const uid = toPositiveInt(userId);
  if (!cid || !uid) return 0;

  const row = await Chat_User.findOne({
    where: { chatId: cid, userId: uid },
    attributes: ["lastReadMessageId"],
    raw: true,
  });
  return toPositiveInt((row as any)?.lastReadMessageId) ?? 0;
};

export const updateChatLastReadMessageId = async (
  chatId: number,
  userId: number,
  lastReadMessageId: number
) => {
  const cid = toPositiveInt(chatId);
  const uid = toPositiveInt(userId);
  const lastId = toPositiveInt(lastReadMessageId);
  if (!cid || !uid || !lastId) return 0;

  const now = new Date();
  await Chat_User.bulkCreate(
    [
      {
        userId: uid,
        chatId: cid,
        pinnedAt: null,
        pinnedOrder: null,
        lastReadMessageId: lastId,
        createdAt: now,
        updatedAt: now,
      },
    ],
    {
      ignoreDuplicates: true,
    }
  );

  const row = await Chat_User.findOne({
    where: { chatId: cid, userId: uid },
  });
  if (!row) return 0;

  const current = toPositiveInt((row as any).lastReadMessageId) ?? 0;
  if (lastId <= current) return current;
  await row.update({ lastReadMessageId: lastId });
  return lastId;
};

export const countUnreadMessagesByChat = async (chatId: number, userId: number) => {
  const cid = toPositiveInt(chatId);
  const uid = toPositiveInt(userId);
  if (!cid || !uid) return 0;

  const lastReadMessageId = await getChatLastReadMessageId(cid, uid);
  const unread = await Message.count({
    where: {
      chatId: cid,
      id: { [Op.gt]: lastReadMessageId },
      senderId: { [Op.ne]: uid },
      deletedBy: { [Op.in]: [0, uid] },
    },
  });
  return Number(unread) || 0;
};

export const getActiveMembership = async (groupId: number, userId: number) => {
  return GroupMember.findOne({
    where: {
      groupId,
      userId,
      isActive: true,
    },
  });
};

export const addOrReactivateMember = async (groupId: number, userId: number) => {
  const existing = await GroupMember.findOne({
    where: {
      groupId,
      userId,
    },
  });

  if (!existing) {
    const created = await GroupMember.create({
      groupId,
      userId,
      role: "member",
      isActive: true,
    });
    await attachUserToGroupChat(groupId, userId);
    return created;
  }

  const keepRole =
    existing.role === "owner" || existing.role === "admin" ? existing.role : "member";
  await existing.update({
    role: keepRole,
    isActive: true,
  });
  await attachUserToGroupChat(groupId, userId);
  return existing;
};

export const createOrRefreshJoinRequest = async (
  groupId: number,
  userId: number,
  inviteId: number | null,
  note: string | null = null
) => {
  const existing = await GroupJoinRequest.findOne({
    where: {
      groupId,
      userId,
    },
  });

  if (!existing) {
    const created = await GroupJoinRequest.create({
      groupId,
      userId,
      inviteId,
      status: "pending",
      reviewedByUserId: null,
      reviewedAt: null,
      note: note ?? null,
    });
    return { request: created, alreadyPending: false };
  }

  if (String((existing as any).status ?? "") === "pending") {
    return { request: existing, alreadyPending: true };
  }

  await existing.update({
    inviteId,
    status: "pending",
    reviewedByUserId: null,
    reviewedAt: null,
    note: note ?? null,
  });
  return { request: existing, alreadyPending: false };
};

export const getJoinRequestById = async (groupId: number, requestId: number) => {
  return GroupJoinRequest.findOne({
    where: {
      id: requestId,
      groupId,
    },
    include: [
      {
        model: User,
        as: "request_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
      {
        model: User,
        as: "reviewer_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
  });
};

export const getJoinRequestsByGroup = async (
  groupId: number,
  status?: "pending" | "approved" | "rejected"
) => {
  const where: any = { groupId };
  if (status) where.status = status;
  return GroupJoinRequest.findAll({
    where,
    order: [["id", "DESC"]],
    include: [
      {
        model: User,
        as: "request_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
      {
        model: User,
        as: "reviewer_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
        required: false,
      },
    ],
  });
};

export const getPendingJoinRequestByUser = async (groupId: number, userId: number) => {
  return GroupJoinRequest.findOne({
    where: {
      groupId,
      userId,
      status: "pending",
    },
  });
};

export const reviewJoinRequest = async ({
  groupId,
  requestId,
  reviewerUserId,
  approve,
  note,
}: {
  groupId: number;
  requestId: number;
  reviewerUserId: number;
  approve: boolean;
  note?: string | null;
}) => {
  const transaction = await sequelize.transaction();
  try {
    const request = await GroupJoinRequest.findOne({
      where: {
        id: requestId,
        groupId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!request) {
      await transaction.rollback();
      return { ok: false as const, reason: "request_not_found" as const };
    }

    const currentStatus = String((request as any).status ?? "");
    if (currentStatus !== "pending") {
      await transaction.rollback();
      return { ok: false as const, reason: "request_already_reviewed" as const, request };
    }

    const group = await Group.findOne({
      where: {
        id: groupId,
        isActive: true,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!group) {
      await transaction.rollback();
      return { ok: false as const, reason: "group_not_found" as const };
    }

    if (approve) {
      const maxMembers = Number((group as any).maxMembers ?? 0);
      const membersCount = await GroupMember.count({
        where: {
          groupId,
          isActive: true,
        },
        transaction,
      });
      if (maxMembers > 0 && membersCount >= maxMembers) {
        await transaction.rollback();
        return { ok: false as const, reason: "group_full" as const };
      }

      const existingMember = await GroupMember.findOne({
        where: {
          groupId,
          userId: Number((request as any).userId),
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (!existingMember) {
        await GroupMember.create(
          {
            groupId,
            userId: Number((request as any).userId),
            role: "member",
            isActive: true,
          },
          { transaction }
        );
      } else {
        const keepRole =
          existingMember.role === "owner" || existingMember.role === "admin"
            ? existingMember.role
            : "member";
        await existingMember.update({ role: keepRole, isActive: true }, { transaction });
      }

      await attachUserToGroupChat(
        groupId,
        Number((request as any).userId),
        transaction
      );

      const inviteId = Number((request as any).inviteId ?? 0);
      if (inviteId > 0) {
        const invite = await GroupInvite.findByPk(inviteId, { transaction });
        if (invite) {
          const nextCount = Number((invite as any).usesCount ?? 0) + 1;
          const maxUses = Number((invite as any).maxUses ?? 0);
          await invite.update(
            {
              usesCount: nextCount,
              isActive: maxUses > 0 ? nextCount < maxUses : true,
            },
            { transaction }
          );
        }
      }
    }

    await request.update(
      {
        status: approve ? "approved" : "rejected",
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        note: note ?? null,
      },
      { transaction }
    );

    await transaction.commit();
    return { ok: true as const, request };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

export const removeMemberByAdmin = async ({
  groupId,
  actorUserId,
  targetUserId,
}: {
  groupId: number;
  actorUserId: number;
  targetUserId: number;
}) => {
  const actorRole = await getActorRoleInGroup(groupId, actorUserId);
  if (actorRole !== "owner" && actorRole !== "admin") {
    return { ok: false as const, reason: "forbidden" as const };
  }

  const group = await getActiveGroupById(groupId);
  if (!group) return { ok: false as const, reason: "group_not_found" as const };

  const ownerUserId = Number((group as any).ownerUserId);
  if (targetUserId === ownerUserId) {
    return { ok: false as const, reason: "cannot_remove_owner" as const };
  }

  const targetMembership = await getActiveMembership(groupId, targetUserId);
  if (!targetMembership) {
    return { ok: false as const, reason: "target_not_member" as const };
  }

  const targetRole = String((targetMembership as any).role ?? "member").toLowerCase();
  if (actorRole === "admin" && (targetRole === "admin" || targetRole === "owner")) {
    return { ok: false as const, reason: "admin_cannot_remove_admin" as const };
  }

  await targetMembership.update({ isActive: false });
  await detachUserFromGroupChat(groupId, targetUserId);
  return { ok: true as const };
};

export const createInviteCode = async (payload: CreateInvitePayload) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateInviteCode();
    try {
      const invite = await GroupInvite.create({
        groupId: payload.groupId,
        createdByUserId: payload.createdByUserId,
        code,
        expiresAt: payload.expiresAt,
        maxUses: payload.maxUses,
        usesCount: 0,
        isActive: true,
      });
      return invite;
    } catch (error: any) {
      if (String(error?.name ?? "").includes("UniqueConstraint")) continue;
      throw error;
    }
  }
  throw new Error("could not generate unique invite code");
};

export const getActiveInviteByCode = async (codeRaw: any) => {
  const code = normalizeInviteCode(codeRaw);
  if (!code) return null;
  return GroupInvite.findOne({
    where: {
      code,
      isActive: true,
    },
  });
};

export const disableInvite = async (inviteId: number) => {
  const invite = await GroupInvite.findByPk(inviteId);
  if (!invite) return null;
  await invite.update({ isActive: false });
  return invite;
};

export const consumeInviteUse = async (inviteId: number) => {
  const invite = await GroupInvite.findByPk(inviteId);
  if (!invite) return null;

  const nextCount = Number((invite as any).usesCount ?? 0) + 1;
  const maxUses = Number((invite as any).maxUses ?? 0);
  await invite.update({
    usesCount: nextCount,
    isActive: maxUses > 0 ? nextCount < maxUses : true,
  });
  return invite;
};

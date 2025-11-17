import User from "../../_models/user/user";
import Like from "../../_models/like/like";
import Post from "../../_models/post/post";
import Offer from "../../_models/offer/offer";
import Worker from "../../_models/worker/worker";
import Message from "../../_models/chat/message";
import Service from "../../_models/service/service";
import MediaPost from "../../_models/post/media_post";
import Notification from "../../_models/notification/notification";
const excludeKeys = ["createdAt ", "updatedAt ", "password "];
export const add = async (body: any) => {
  const notification = await Notification.create(body);
  return notification;
};

export const gets = async () => {
  const notification = await Notification.findAll({
    where: {},
  });
  return notification;
};

export const myNotifications = async (id: number) => {
  const notification = await Notification.findAll({
    where: { userId: id, deleted: false },
    include: [
      {
        model: User,
        as: "interactor",
        attributes: ["id", "name", "last_name", "image_profil"],
      },
      {
        model: Service,
        as: "service",
      },
      {
        model: Offer,
        as: "offer",
        attributes: ["id", "serviceId", "workerId"],
        include: [
          {
            model: Service,
            as: "service",
          },
          {
            model: Worker,
            as: "offerer",
            attributes: ["id", "userId"],
          },
        ],
      },
      {
        model: Post,
        as: "post",
        attributes: ["id", "userId"],
        include: [
          {
            model: MediaPost,
            as: "post_media",
            attributes: ["url", "is_img"],
            order: [["createdAt", "ASC"]],
            required: false,
            separate: true,
          },
        ],
      },
      {
        model: Like,
        as: "like",
        attributes: ["id", "userId", "postId"],
      },
      {
        model: Message,
        as: "message_received",
        attributes: ["id", "senderId", "text"],
      },
    ],
    order: [["notification_date", "DESC"]],
  });
  return notification;
};
export const get = async (id: any) => {
  const notification = await Notification.findOne({ where: { id: id } });
  return notification;
};

export const update = async (userId: number, id: any, body: any) => {
  const notificationTemp = await Notification.findOne({
    where: {
      userId: userId,
      id: id,
    },
  });
  const notification = await notificationTemp?.update(body);
  return [notification];
};

export const read = async (id: number) => {
  const notification = await Notification.update(
    { read: true },
    { where: { id: id } }
  );
  return notification;
};

export const readAllByUser = async (userId: number) => {
  const notification = await Notification.update(
    { read: true },
    { where: { userId: userId } }
  );
  return notification;
};

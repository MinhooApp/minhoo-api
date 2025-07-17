import sequelize from "../../_db/connection";
import { DataTypes, Model, Optional } from "sequelize";
import {
  TypeNotification,
  TypeNotificationEnum,
} from "_models/notification/type_notification";

interface NotificationAttributes {
  id: number;
  userId: number;
  interactorId: number;
  serviceId?: number;
  postId?: number;
  offerId?: number;
  type: TypeNotification;
  message: string;
  likerId?: number;
  commentId?: number;
  messageId?: number;
  notification_date?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  read: boolean;
  deleted: boolean;
}

interface NotificationCreationAttributes
  extends Optional<NotificationAttributes, "id"> {}

class Notification
  extends Model<NotificationAttributes, NotificationCreationAttributes>
  implements NotificationAttributes
{
  public id!: number;
  public userId!: number;
  public interactorId!: number;
  public serviceId?: number;
  public postId?: number;
  public offerId?: number;
  public type!: TypeNotification;
  public message!: string;
  public likerId?: number;
  public commentId?: number;
  public messageId?: number;
  public notification_date?: Date;
  public createdAt!: Date;
  public updatedAt!: Date;
  public read!: boolean;
  public deleted!: boolean;
}

Notification.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    interactorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    serviceId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    postId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    offerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    type: {
      type: DataTypes.ENUM(...TypeNotificationEnum),
      allowNull: false,
    },
    message: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    likerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    commentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    messageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    notification_date: {
      type: DataTypes.DATE,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'notification_date' can't be null",
        },
        notEmpty: {
          msg: "The field 'notification_date' can't be empty",
        },
      },
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    deleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    modelName: "notification",
  }
);

export default Notification;

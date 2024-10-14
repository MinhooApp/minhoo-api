import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../../_db/connection";

interface NotificationAttributes {
  id: number;
  userId: number;
  interactorId: number;
  serviceId?: number;
  postId?: number;
  offerId?: number;
  type:
    | "postulation"
    | "comment"
    | "offerAccepted"
    | "like"
    | "admin"
    | "message";
  message: string;
  likerId?: number; // ID del usuario que dio el "like"
  commentId?: number; // ID del comentario
  messageId?: number; // ID del mensaje
  notification_date?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  read: boolean; // Nuevo campo para indicar si la notificación ha sido leída
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
  public type!:
    | "postulation"
    | "comment"
    | "offerAccepted"
    | "like"
    | "admin"
    | "message";
  public message!: string;
  public likerId?: number;
  public commentId?: number;
  public messageId?: number;
  public notification_date?: Date;
  public createdAt!: Date;
  public updatedAt!: Date;
  public read!: boolean; // Nuevo campo para indicar si la notificación ha sido leída
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
      type: DataTypes.ENUM(
        "postulation",
        "comment",
        "offerAccepted",
        "like",
        "admin",
        "message"
      ),
      allowNull: false,
    },
    message: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    likerId: {
      type: DataTypes.INTEGER,
      allowNull: true, // Puede ser null si no aplica
    },
    commentId: {
      type: DataTypes.INTEGER,
      allowNull: true, // Puede ser null si no aplica
    },
    messageId: {
      type: DataTypes.INTEGER,
      allowNull: true, // Puede ser null si no aplica
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
      defaultValue: false, // Asumimos que la notificación no está leída al momento de su creación
    },
  },
  {
    sequelize,
    modelName: "notification",
  }
);

export default Notification;

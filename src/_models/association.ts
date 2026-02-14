import Plan from "./plan/plan";
import Post from "./post/post";
import Role from "./role/role";
import User from "./user/user";
import Like from "./like/like";
import Chat from "./chat/chat";
import Offer from "./offer/offer";
import Message from "./chat/message";
import Worker from "./worker/worker";
import Service from "./service/service";
import Comment from "./comment/comment";
import Chat_User from "./chat/chat_user";
import MediaPost from "./post/media_post";
import Category from "./category/category";
import Follower from "./follower/follower";
import MediaWorker from "./worker/media_worker";
import StatusService from "./status/statusService";
import Service_Worker from "./service/service_worker";
import Verification from "./verification/verification";
import Notification from "./notification/notification";
import UserBlock from "./block/block";
const ver = Verification;
console.log(ver.toString());

//Association User with Roles
User.belongsToMany(Role, { through: "user_role" });
Role.belongsToMany(User, { through: "user_role" });

//Association Plan with User
Plan.hasMany(User, { as: "users", foreignKey: "planId" });
User.belongsTo(Plan, { as: "plan", foreignKey: "planId" });

//Association Post with User
User.hasMany(Post, { as: "posts", foreignKey: "userId" });
Post.belongsTo(User, { as: "user", foreignKey: "userId" });

//Association Post with User
User.hasMany(Comment, { as: "comments", foreignKey: "userId" });
Comment.belongsTo(User, { as: "commentator", foreignKey: "userId" });

//Association Comment with Post
Post.hasMany(Comment, { as: "comments", foreignKey: "postId" });
Comment.belongsTo(Post, { as: "post", foreignKey: "postId" });

//Association Like with User
User.hasMany(Like, { as: "likes", foreignKey: "userId" });
Like.belongsTo(User, { as: "user", foreignKey: "userId" });

//Association Like with Post
Post.hasMany(Like, { as: "likes", foreignKey: "postId" });
Like.belongsTo(Post, { as: "post", foreignKey: "postId" });
//Association Post with Category

Category.hasMany(Post, { as: "posts", foreignKey: "categoryId" });
Post.belongsTo(Category, { as: "categry", foreignKey: "categoryId" });

//Association Post with MediaPost
Post.hasMany(MediaPost, { as: "post_media", foreignKey: "postId" });
MediaPost.belongsTo(Post, { as: "post", foreignKey: "postId" });

//Association Like with Comment
Comment.hasMany(Like, { as: "likes", foreignKey: "commentId" });
Like.belongsTo(Comment, { as: "comment", foreignKey: "commentId" });

//Association User with Category
User.belongsToMany(Category, { through: "user_category" });
Category.belongsToMany(User, { through: "user_category" });

//Association Worker with User
User.hasOne(Worker, { as: "worker", foreignKey: "userId" });
Worker.belongsTo(User, { as: "personal_data", foreignKey: "userId" });
//Association Worker with Plan
Plan.hasMany(Worker, { as: "workers", foreignKey: "planId" });
Worker.belongsTo(Plan, { as: "plan", foreignKey: "planId" });

//Association Worker with Category
Worker.belongsToMany(Category, { through: "worker_category" });
Category.belongsToMany(Worker, { through: "worker_category" });

//Association Service with User
User.hasMany(Service, { as: "services", foreignKey: "userId" });
Service.belongsTo(User, { as: "client", foreignKey: "userId" });

//Association Service with Category
Category.hasMany(Service, { as: "services", foreignKey: "categoryId" });
Service.belongsTo(Category, { as: "category", foreignKey: "categoryId" });
//Association Offer with Service
Service.hasMany(Offer, { as: "offers", foreignKey: "serviceId" });
Offer.belongsTo(Service, { as: "service", foreignKey: "serviceId" });

//Association Offer with Worker
Worker.hasMany(Offer, { as: "offers", foreignKey: "workerId" });
Offer.belongsTo(Worker, { as: "offerer", foreignKey: "workerId" });

//Association Service with Service_Worker

// En el modelo Chat_User
Service_Worker.belongsTo(Service, { foreignKey: "serviceId" });
Service_Worker.belongsTo(Worker, { foreignKey: "workerId" });
//Association Worker with MediaWorkwe
Worker.hasMany(MediaWorker, { as: "worker_media", foreignKey: "workerId" });
MediaWorker.belongsTo(Worker, { as: "worker", foreignKey: "workerId" });

//Association User with Fallower
User.hasMany(Follower, { as: "followers", foreignKey: "userId" });
Follower.belongsTo(User, { as: "following_data", foreignKey: "userId" });
User.hasMany(Follower, { as: "followings", foreignKey: "followerId" });
Follower.belongsTo(User, { as: "follower_data", foreignKey: "followerId" });

//Association User with chats
User.belongsToMany(Chat, { through: Chat_User, foreignKey: "userId" });
Chat.belongsToMany(User, { through: Chat_User, foreignKey: "chatId" });

//Association Message with Chat
Chat.hasMany(Message, { as: "messages", foreignKey: "chatId" });
Message.belongsTo(Chat, { as: "chat", foreignKey: "chatId" });
//Association Message with User
User.hasMany(Message, { as: "messages", foreignKey: "senderId" });
Message.belongsTo(User, { as: "sender", foreignKey: "senderId" });

//Association Worker with Service
Worker.belongsToMany(Service, {
  through: Service_Worker,
  as: "services",
  foreignKey: "workerId",
});
Service.belongsToMany(Worker, {
  through: Service_Worker,
  as: "workers",
  foreignKey: "serviceId",
});

//Association Service with statusService//
StatusService.hasMany(Service, { as: "services", foreignKey: "statusId" });
Service.belongsTo(StatusService, { as: "status", foreignKey: "statusId" });
///User.belongsToMany(Role, { through: User_Role, as: "roles", foreignKey: "user_id", });
//Role.belongsToMany(User, { through: User_Role, as: "users", foreignKey: "role_id", });

// En el modelo Chat_User
Chat_User.belongsTo(User, { foreignKey: "userId" });
Chat_User.belongsTo(Chat, { foreignKey: "chatId" });

// En el modelo Chat
Chat.belongsToMany(User, {
  through: Chat_User,
  foreignKey: "chatId",
  as: "user_chat",
});
// En el modelo User
User.belongsToMany(Chat, {
  through: Chat_User,
  foreignKey: "userId",
  as: "user_chat",
});

//NOTIFICATION//
// Asociación Notification con User
User.hasMany(Notification, { as: "notifications", foreignKey: "userId" });
Notification.belongsTo(User, { as: "user", foreignKey: "userId" });
// Asociación Notification con User interactor
User.hasMany(Notification, { as: "interactions", foreignKey: "interactorId" });
Notification.belongsTo(User, { as: "interactor", foreignKey: "interactorId" });

// Asociación Notification con Post
Post.hasMany(Notification, { as: "notifications", foreignKey: "postId" });
Notification.belongsTo(Post, { as: "post", foreignKey: "postId" });

// Asociación Notification con Comment
Comment.hasMany(Notification, { as: "notifications", foreignKey: "commentId" });
Notification.belongsTo(Comment, { as: "comment", foreignKey: "commentId" });

// Asociación Notification con Like
Like.hasMany(Notification, { as: "notifications", foreignKey: "likerId" });
Notification.belongsTo(Like, { as: "like", foreignKey: "likerId" });

// Asociación Notification con Message
Message.hasMany(Notification, { as: "notifications", foreignKey: "messageId" });
Notification.belongsTo(Message, {
  as: "message_received",
  foreignKey: "messageId",
});

// Asociación Notification con Offer
Offer.hasMany(Notification, { as: "notifications", foreignKey: "offerId" });
Notification.belongsTo(Offer, { as: "offer", foreignKey: "offerId" });

// Asociación Notification con Service
Service.hasMany(Notification, { as: "notifications", foreignKey: "serviceId" });
Notification.belongsTo(Service, { as: "service", foreignKey: "serviceId" });

// Asociation User Bloc
// user.model.js
User.hasMany(UserBlock, { foreignKey: "blocker_id", as: "blocksMade" });
User.hasMany(UserBlock, { foreignKey: "blocked_id", as: "blocksReceived" });

// block.model.js
UserBlock.belongsTo(User, { foreignKey: "blocker_id", as: "blocker" });
UserBlock.belongsTo(User, { foreignKey: "blocked_id", as: "blocked" });

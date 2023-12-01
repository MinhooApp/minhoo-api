import Plan from "./plan/plan";
import Post from "./post/post";
import Role from "./role/role";
import User from "./user/user";
import Like from "./like/like";
import Comment from "./comment/comment";
import Category from "./category/category";
import MediaPost from "./post/media_post";
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
Comment.belongsTo(User, { as: "user", foreignKey: "userId" });

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




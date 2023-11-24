import Plan from "./plan/plan";
import Post from "./post/post";
import Role from "./role/role";
import User from "./user/user";

//Association User with Roles
User.belongsToMany(Role, { through: "user_role" });
Role.belongsToMany(User, { through: "user_role" });


//Association Plan with User
Plan.hasMany(User, { as: "users", foreignKey: "planId" });
User.belongsTo(Plan, { as: "plan", foreignKey: "planId" });

//Association Post with USer
User.hasMany(Post, { as: "posts", foreignKey: "userId" });
Post.belongsTo(User, { as: "user", foreignKey: "userId" });
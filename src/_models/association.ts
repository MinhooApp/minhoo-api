import Role from "./role/role";
import User from "./user/user";

User.belongsToMany(Role, { through: "user_role" });
Role.belongsToMany(User, { through: "user_role" });
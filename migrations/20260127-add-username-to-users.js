module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("Users", "username", {
      type: Sequelize.STRING(30),
      allowNull: true,
      unique: true,
    });
    await queryInterface.addColumn("Users", "username_updated_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("Users", "username_updated_at");
    await queryInterface.removeColumn("Users", "username");
  },
};

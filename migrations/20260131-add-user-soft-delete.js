module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Users");
    if (!table.is_deleted) {
      await queryInterface.addColumn("Users", "is_deleted", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
    if (!table.deleted_at) {
      await queryInterface.addColumn("Users", "deleted_at", {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("Users", "deleted_at");
    await queryInterface.removeColumn("Users", "is_deleted");
  },
};

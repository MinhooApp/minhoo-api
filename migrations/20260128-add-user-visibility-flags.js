module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Users");
    if (!table.show_email) {
      await queryInterface.addColumn("Users", "show_email", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    }
    if (!table.show_phone) {
      await queryInterface.addColumn("Users", "show_phone", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    }
    if (!table.show_languages) {
      await queryInterface.addColumn("Users", "show_languages", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    }
    if (!table.show_location) {
      await queryInterface.addColumn("Users", "show_location", {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("Users", "show_location");
    await queryInterface.removeColumn("Users", "show_languages");
    await queryInterface.removeColumn("Users", "show_phone");
    await queryInterface.removeColumn("Users", "show_email");
  },
};

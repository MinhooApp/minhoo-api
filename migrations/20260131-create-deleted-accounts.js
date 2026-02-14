module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("deleted_accounts", {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      deleted_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      reason: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      ip: {
        type: Sequelize.STRING,
        allowNull: true,
      },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable("deleted_accounts");
  },
};

// C:\\api\\minhoo_api\\migrations\\20251111-add-chat-pin.js
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("chat_user", "pinnedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("chat_user", "pinnedOrder", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex("chat_user", ["userId", "pinnedAt"], {
      name: "idx_chat_user_user_pinnedAt",
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("chat_user", "idx_chat_user_user_pinnedAt");
    await queryInterface.removeColumn("chat_user", "pinnedOrder");
    await queryInterface.removeColumn("chat_user", "pinnedAt");
  },
};

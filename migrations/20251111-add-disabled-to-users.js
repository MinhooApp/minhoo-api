// C:\api\minhoo_api\migrations\20251111-add-disabled-to-users.js
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'disabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'disabled');
  }
};

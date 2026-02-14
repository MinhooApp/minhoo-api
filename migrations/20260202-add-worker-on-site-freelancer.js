'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = 'workers';
    const schema = await queryInterface.describeTable(table);

    if (!schema.on_site) {
      await queryInterface.addColumn(table, 'on_site', {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      });
    }

    if (!schema.freelancer) {
      await queryInterface.addColumn(table, 'freelancer', {
        type: Sequelize.BOOLEAN,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = 'workers';
    const schema = await queryInterface.describeTable(table);
    if (schema.freelancer) {
      await queryInterface.removeColumn(table, 'freelancer');
    }
    if (schema.on_site) {
      await queryInterface.removeColumn(table, 'on_site');
    }
  },
};

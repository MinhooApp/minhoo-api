"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.removeColumn("workers", "on_site");
    await queryInterface.removeColumn("workers", "freelancer");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("workers", "on_site", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await queryInterface.addColumn("workers", "freelancer", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
  },
};

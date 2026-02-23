"use strict";

const TABLE_NAME = "messages";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE_NAME);
    if (!table.messageType) return;

    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === "mysql" || dialect === "mariadb") {
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${TABLE_NAME}\` MODIFY COLUMN \`messageType\` ENUM('text','voice','image','video') NOT NULL DEFAULT 'text'`
      );
      return;
    }

    await queryInterface.changeColumn(TABLE_NAME, "messageType", {
      type: Sequelize.ENUM("text", "voice", "image", "video"),
      allowNull: false,
      defaultValue: "text",
    });
  },

  async down(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE_NAME);
    if (!table.messageType) return;

    await queryInterface.sequelize.query(
      `UPDATE \`${TABLE_NAME}\` SET \`messageType\`='text', \`mediaUrl\`=NULL, \`mediaMime\`=NULL, \`mediaDurationMs\`=NULL, \`mediaSizeBytes\`=NULL, \`waveform\`=NULL WHERE \`messageType\` IN ('image','video')`
    );

    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === "mysql" || dialect === "mariadb") {
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${TABLE_NAME}\` MODIFY COLUMN \`messageType\` ENUM('text','voice') NOT NULL DEFAULT 'text'`
      );
      return;
    }

    await queryInterface.changeColumn(TABLE_NAME, "messageType", {
      type: Sequelize.ENUM("text", "voice"),
      allowNull: false,
      defaultValue: "text",
    });
  },
};

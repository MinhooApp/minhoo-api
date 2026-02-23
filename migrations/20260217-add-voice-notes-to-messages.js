"use strict";

const TABLE_NAME = "messages";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE_NAME);

    if (!table.messageType) {
      await queryInterface.addColumn(TABLE_NAME, "messageType", {
        type: Sequelize.ENUM("text", "voice"),
        allowNull: false,
        defaultValue: "text",
      });
    }

    if (!table.mediaUrl) {
      await queryInterface.addColumn(TABLE_NAME, "mediaUrl", {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    if (!table.mediaMime) {
      await queryInterface.addColumn(TABLE_NAME, "mediaMime", {
        type: Sequelize.STRING(120),
        allowNull: true,
      });
    }

    if (!table.mediaDurationMs) {
      await queryInterface.addColumn(TABLE_NAME, "mediaDurationMs", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    if (!table.mediaSizeBytes) {
      await queryInterface.addColumn(TABLE_NAME, "mediaSizeBytes", {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    if (!table.waveform) {
      await queryInterface.addColumn(TABLE_NAME, "waveform", {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }

    if (table.text && table.text.allowNull === false) {
      await queryInterface.changeColumn(TABLE_NAME, "text", {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE_NAME);

    if (table.waveform) {
      await queryInterface.removeColumn(TABLE_NAME, "waveform");
    }
    if (table.mediaSizeBytes) {
      await queryInterface.removeColumn(TABLE_NAME, "mediaSizeBytes");
    }
    if (table.mediaDurationMs) {
      await queryInterface.removeColumn(TABLE_NAME, "mediaDurationMs");
    }
    if (table.mediaMime) {
      await queryInterface.removeColumn(TABLE_NAME, "mediaMime");
    }
    if (table.mediaUrl) {
      await queryInterface.removeColumn(TABLE_NAME, "mediaUrl");
    }
    if (table.messageType) {
      await queryInterface.removeColumn(TABLE_NAME, "messageType");
    }

    if (table.text && table.text.allowNull === true) {
      await queryInterface.sequelize.query(
        `UPDATE ${TABLE_NAME} SET text = '' WHERE text IS NULL`
      );
      await queryInterface.changeColumn(TABLE_NAME, "text", {
        type: Sequelize.TEXT,
        allowNull: false,
      });
    }
  },
};

"use strict";

const TABLE_NAME = "notifications";
const COLUMN_NAME = "type";

const OLD_NOTIFICATION_TYPES = [
  "postulation",
  "comment",
  "offerAccepted",
  "applicationCanceled",
  "applicationRemoved",
  "like",
  "admin",
  "follow",
  "message",
  "requestCanceled",
  "newService",
];

const NEW_NOTIFICATION_TYPES = [
  "postulation",
  "comment",
  "offerAccepted",
  "applicationCanceled",
  "applicationRemoved",
  "like",
  "admin",
  "follow",
  "profile_recommendation",
  "message",
  "requestCanceled",
  "newService",
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface
      .describeTable(TABLE_NAME)
      .then(() => true)
      .catch(() => false);

    if (!tableExists) return;

    const schema = await queryInterface.describeTable(TABLE_NAME);
    if (!schema[COLUMN_NAME]) return;

    await queryInterface.changeColumn(TABLE_NAME, COLUMN_NAME, {
      type: Sequelize.ENUM(...NEW_NOTIFICATION_TYPES),
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    const tableExists = await queryInterface
      .describeTable(TABLE_NAME)
      .then(() => true)
      .catch(() => false);

    if (!tableExists) return;

    const schema = await queryInterface.describeTable(TABLE_NAME);
    if (!schema[COLUMN_NAME]) return;

    await queryInterface.sequelize.query(
      `
        UPDATE ${TABLE_NAME}
        SET ${COLUMN_NAME} = 'admin'
        WHERE ${COLUMN_NAME} = 'profile_recommendation'
      `
    );

    await queryInterface.changeColumn(TABLE_NAME, COLUMN_NAME, {
      type: Sequelize.ENUM(...OLD_NOTIFICATION_TYPES),
      allowNull: false,
    });
  },
};

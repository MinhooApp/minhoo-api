'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [results] = await sequelize.query(`
      SELECT CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'notifications'
        AND COLUMN_NAME = 'commentId'
        AND REFERENCED_TABLE_NAME IS NOT NULL
    `);

    for (const row of results || []) {
      const name = row.CONSTRAINT_NAME;
      if (!name) continue;
      await queryInterface.removeConstraint('notifications', name);
    }
  },

  async down(queryInterface) {
    await queryInterface.addConstraint('notifications', {
      fields: ['commentId'],
      type: 'foreign key',
      name: 'notifications_ibfk_6',
      references: {
        table: 'comments',
        field: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },
};

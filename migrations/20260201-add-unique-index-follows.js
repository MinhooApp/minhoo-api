'use strict';

module.exports = {
  async up(queryInterface) {
    const table = 'followers';

    // Dedup in case there are repeated rows
    await queryInterface.sequelize.query(`
      DELETE f1
      FROM \`${table}\` f1
      INNER JOIN \`${table}\` f2
        ON f1.userId = f2.userId
       AND f1.followerId = f2.followerId
       AND f1.id > f2.id
    `);

    const indexes = await queryInterface.showIndex(table);
    const hasIndex = indexes.some((idx) => idx.name === 'uniq_follow_user_follower');
    if (!hasIndex) {
      await queryInterface.addIndex(table, ['userId', 'followerId'], {
        unique: true,
        name: 'uniq_follow_user_follower',
      });
    }
  },

  async down(queryInterface) {
    const table = 'followers';
    const indexes = await queryInterface.showIndex(table);
    const hasIndex = indexes.some((idx) => idx.name === 'uniq_follow_user_follower');
    if (hasIndex) {
      await queryInterface.removeIndex(table, 'uniq_follow_user_follower');
    }
  },
};

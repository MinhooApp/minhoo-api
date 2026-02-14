module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("Users", "job_category_ids", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "job_categories_labels", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "language_ids", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "language_codes", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "language_names", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "country_origin_id", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "country_origin_code", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "country_residence_id", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "state_residence_id", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "state_residence_code", {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "city_residence_id", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("Users", "city_residence_name", {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("Users", "city_residence_name");
    await queryInterface.removeColumn("Users", "city_residence_id");
    await queryInterface.removeColumn("Users", "state_residence_code");
    await queryInterface.removeColumn("Users", "state_residence_id");
    await queryInterface.removeColumn("Users", "country_residence_id");
    await queryInterface.removeColumn("Users", "country_origin_code");
    await queryInterface.removeColumn("Users", "country_origin_id");
    await queryInterface.removeColumn("Users", "language_names");
    await queryInterface.removeColumn("Users", "language_codes");
    await queryInterface.removeColumn("Users", "language_ids");
    await queryInterface.removeColumn("Users", "job_categories_labels");
    await queryInterface.removeColumn("Users", "job_category_ids");
  },
};

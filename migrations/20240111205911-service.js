'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
     await queryInterface.createTable('services', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
        references: {
          model: 'users', // Nombre de la tabla en minúsculas
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      categoryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
        references: {
          model: 'categories', // Nombre de la tabla en minúsculas
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      description: {
        type: Sequelize.STRING,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
      },
        rate: {
        type: Sequelize.DOUBLE,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
      },
      service_date: {
        type: Sequelize.DATE,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
      },
      longitude: {
        type: Sequelize.DOUBLE,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
      },
      latitude: {
        type: Sequelize.DOUBLE,
        allowNull: false,
        validate: {
          notNull: true,
          notEmpty: true,
        },
      },
      is_available: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    // Asegúrate de que estas claves foráneas estén indexadas
    await queryInterface.addIndex('services', ['userId']);
    await queryInterface.addIndex('services', ['categoryId']);
  },

  async down (queryInterface, Sequelize) {
  await queryInterface.dropTable('services');
  }
};

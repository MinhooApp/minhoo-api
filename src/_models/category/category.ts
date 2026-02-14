import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Category extends Model {
  [x: string]: any;
}
Category.init(
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'name' can't be null",
        },
        notEmpty: {
          msg: "The field 'name' can't be empty",
        },
      },
    },
    es_name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'es_name' can't be null",
        },
        notEmpty: {
          msg: "The field 'es_name' can't be empty",
        },
      },
    },
    available: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: true,
      validate: {
        notNull: {
          msg: "The field 'available' can't be null",
        },
        notEmpty: {
          msg: "The field 'available' can't be empty",
        },
      },
    },
  },
  {
    sequelize,
    modelName: "category",
  }
);
Category.afterSync(async () => {
  const categories = [
    { id: 1, name: "All", es_name: "Todas" },
    { id: 2, name: "Cleaning Services", es_name: "Servicios de limpieza" },
    { id: 3, name: "Moving & Delivery", es_name: "Mudanzas y entregas" },
    { id: 4, name: "Handyman Services", es_name: "Servicios de mantenimiento" },
    { id: 5, name: "Furniture Assembly", es_name: "Armado de muebles" },
    {
      id: 6,
      name: "Home Repairs & Maintenance",
      es_name: "Reparaciones y mantenimiento del hogar",
    },
    { id: 7, name: "Yardwork & Landscaping", es_name: "Jardineria y paisajismo" },
    {
      id: 8,
      name: "Smart Home & Tech Installation",
      es_name: "Instalacion de tecnologia inteligente",
    },
    {
      id: 9,
      name: "Virtual Assistance & Admin Tasks",
      es_name: "Asistencia virtual y tareas administrativas",
    },
    { id: 10, name: "Beauty & Personal Care", es_name: "Cuidado personal y belleza" },
    {
      id: 11,
      name: "Tech Support & Computer Help",
      es_name: "Soporte tecnico y ayuda con computadoras",
    },
    { id: 12, name: "Personal Shopping & Errands", es_name: "Compras personales y recados" },
    { id: 13, name: "Tutoring & Lessons", es_name: "Tutorias y clases" },
    { id: 14, name: "Pet Care & Dog Walking", es_name: "Cuidado de mascotas y paseos de perros" },
    { id: 15, name: "Event Help & Planning", es_name: "Ayuda y planificacion de eventos" },
    { id: 16, name: "Home Organization", es_name: "Organizacion del hogar" },
    { id: 17, name: "Creative & Design Services", es_name: "Creative & Design Services" },
    { id: 18, name: "Marketing & Content Creation", es_name: "Marketing & Content Creation" },
    { id: 19, name: "Photography & Video", es_name: "Photography & Video" },
    { id: 20, name: "Language & Translation Services", es_name: "Language & Translation Services" },
    { id: 21, name: "Childcare & Babysitting", es_name: "Childcare & Babysitting" },
    { id: 22, name: "Caregiving & Assistance", es_name: "Caregiving & Assistance" },
    {
      id: 23,
      name: "Health & Wellness (Non-medical)",
      es_name: "Health & Wellness (Non-medical)",
    },
    {
      id: 24,
      name: "Companionship & Social Support",
      es_name: "Companionship & Social Support",
    },
    { id: 25, name: "Others", es_name: "Otras" },
    { id: 26, name: "Freelancer", es_name: "Freelancer" },
    { id: 27, name: "On Site", es_name: "En sitio" },
  ];

  try {
    for (const category of categories) {
      await Category.upsert({
        id: category.id,
        name: category.name,
        es_name: category.es_name,
        available: true,
      });
    }
  } catch (error) {
    console.error("Category seed failed:", error);
  }
});

export default Category;

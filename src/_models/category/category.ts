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
<<<<<<< HEAD
    const categories = [
        { id: 1, name: "All", es_name: "Todas" },
        { id: 2, name: "Cleaning Services", es_name: "Servicios de limpieza" },
        { id: 3, name: "Moving & Delivery", es_name: "Mudanzas y entregas" },
        { id: 4, name: "Handyman Services", es_name: "Servicios de mantenimiento" },
        { id: 5, name: "Furniture Assembly", es_name: "Armado de muebles" },
        { id: 6, name: "Home Repairs & Maintenance", es_name: "Reparaciones y mantenimiento del hogar" },
        { id: 7, name: "Yardwork & Landscaping", es_name: "Jardinería y paisajismo" },
        { id: 8, name: "Smart Home & Tech Installation", es_name: "Instalación de tecnología inteligente" },
        { id: 9, name: "Virtual Assistance & Admin Tasks", es_name: "Asistencia virtual y tareas administrativas" },
        { id: 10, name: "Beauty & Personal Care", es_name: "Cuidado personal y belleza" },
        { id: 11, name: "Tech Support & Computer Help", es_name: "Soporte técnico y ayuda con computadoras" },
        { id: 12, name: "Personal Shopping & Errands", es_name: "Compras personales y recados" },
        { id: 13, name: "Tutoring & Lessons", es_name: "Tutorías y clases" },
        { id: 14, name: "Pet Care & Dog Walking", es_name: "Cuidado de mascotas y paseos de perros" },
        { id: 15, name: "Event Help & Planning", es_name: "Ayuda y planificación de eventos" },
        { id: 16, name: "Home Organization", es_name: "Organización del hogar" },
        { id: 17, name: "Others", es_name: "Otras" },
    ];

    for (const category of categories) {
        await Category.findOrCreate({
            where: {
                id: category.id,
                name: category.name,
                es_name: category.es_name,
            },
        });
    }
=======
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
    {
      id: 7,
      name: "Yardwork & Landscaping",
      es_name: "Jardinería y paisajismo",
    },
    {
      id: 8,
      name: "Smart Home & Tech Installation",
      es_name: "Instalación de tecnología inteligente",
    },
    {
      id: 9,
      name: "Virtual Assistance & Admin Tasks",
      es_name: "Asistencia virtual y tareas administrativas",
    },
    {
      id: 10,
      name: "Beauty & Personal Care",
      es_name: "Cuidado personal y belleza",
    },
    {
      id: 11,
      name: "Tech Support & Computer Help",
      es_name: "Soporte técnico y ayuda con computadoras",
    },
    {
      id: 12,
      name: "Personal Shopping & Errands",
      es_name: "Compras personales y recados",
    },
    { id: 13, name: "Tutoring & Lessons", es_name: "Tutorías y clases" },
    {
      id: 14,
      name: "Pet Care & Dog Walking",
      es_name: "Cuidado de mascotas y paseos de perros",
    },
    {
      id: 15,
      name: "Event Help & Planning",
      es_name: "Ayuda y planificación de eventos",
    },
    { id: 16, name: "Home Organization", es_name: "Organización del hogar" },
    { id: 17, name: "Others", es_name: "Otras" },
  ];

  for (const category of categories) {
    await Category.findOrCreate({
      where: {
        id: category.id,
        name: category.name,
        es_name: category.es_name,
      },
    });
  }
>>>>>>> 3b742f639996a5866939ce59dd59e6fb7c46e308
});

export default Category;

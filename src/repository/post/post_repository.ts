import Post from "../../_models/post/post";
import Like from "../../_models/like/like";
import { postInclude } from "./post_include";
import MediaPost from "../../_models/post/media_post";
import { Op, Sequelize } from "sequelize";
import sequelize from "sequelize/types/sequelize";
const excludeKeys = ["createdAt", "updatedAt"];

export const add = async (body: any) => {
  const post: any = await Post.create(body);

  if (body.media_url != null) {
    // Crea una instancia de MediaPost para cada cadena de texto en el array
    const mediaPosts = await Promise.all(
      body.media_url.map(async (str: any) => {
        const mediaPost = await MediaPost.create({
          postId: post.id, // Asigna el postId al id del post creado
          url: str, // Asigna la cadena de texto como URL
          is_img: true, // Opcional: ajusta el valor de is_img según sea necesario
        });
        return mediaPost;
      })
    );
  }

  return post;
};
export const all = async () => {
  const post = await Post.findAll({
    include: postInclude,
  });
  return post;
};

export const gets = async (page: any = 0, size: any = 10) => {
  let option = {
    limit: +size,
    offset: +page * +size,
  };
  const post = await Post.findAndCountAll({
    where: { is_delete: false },
    ...option,
    include: postInclude,

    order: [["created_date", "DESC"]],
    attributes: { exclude: excludeKeys },
  });

  return post;
};
/*export const gets = async (page: any = 0, size: any = 10, meId: any = -1) => {
  const option = { limit: +size, offset: +page * +size };

  const andConds: any[] = [];
  const me = Number(meId);
  /*if (Number.isFinite(me)) {
    andConds.push(
      Sequelize.literal(`
        NOT EXISTS (
          SELECT 1
          FROM user_blocks ub
          WHERE
            (ub.blocker_id = ${me} AND ub.blocked_id = \`post\`.\`userId\`)
            OR
            (ub.blocker_id = \`post\`.\`userId\` AND ub.blocked_id = ${me})
        )
      `)
    );
  }*/

/*const posts = await Post.findAndCountAll({
    where: {
      is_delete: false,
      ...(andConds.length ? { [Op.and]: andConds } : {}),
    },
    ...option,
    include: postInclude,
    order: [["created_date", "DESC"]],
    attributes: { exclude: excludeKeys },
    subQuery: false,
  });

  return posts;
};*/
// /
export const getOne = async (id: any, meId: any) => {
  const post = await Post.findOne({
    where: {
      id: id,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`post\`.\`userId\`)
              OR
              (ub.blocker_id = \`post\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    replacements: { meId },
    include: postInclude,
    attributes: { exclude: excludeKeys },
  });
  return post;
};
export const get = async (id: any, meId: any = -1) => {
  const post = await Post.findOne({
    where: {
      id: id,
      is_delete: false,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`post\`.\`userId\`)
              OR
              (ub.blocker_id = \`post\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    replacements: { meId },
    include: postInclude,
  });
  return post;
};
export const getOneByUser = async (id: any, userId: any, meId: any = -1) => {
  const post = await Post.findOne({
    where: {
      id: id,
      userId: userId,
      is_delete: false,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`post\`.\`userId\`)
              OR
              (ub.blocker_id = \`post\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    replacements: { meId },
    include: postInclude,
  });
  return post;
};
export const update = async (id: any, body: any) => {
  const postTemp = await Post.findByPk(id, {
    include: postInclude,
    attributes: { exclude: excludeKeys },
  });
  const post = await postTemp?.update(body);
  return [post];
};

export const deletePost = async (id: any) => {
  const post = await Post.update({ is_delete: true }, { where: { id: id } });
  return post;
};
export const toggleLike = async (userId: any, postId: any) => {
  // Buscar si ya existe una fila con los IDs proporcionados
  const existingFollow = await Like.findOne({
    where: {
      userId,
      postId,
    },
  });

  if (existingFollow) {
    // Si existe, eliminar la fila para dejar de gustar
    await existingFollow.destroy();
    return false; // Ya no le gusta al usuario
  } else {
    // Si no existe, crear una nueva fila para like
    await Like.create({
      userId,
      postId,
    });
    return true; // like
  }
};

// C:\api\minhoo_api\src\_routes\routes.ts
import { Router } from "express";

// 👇 Importa todas las rutas estándar
import user_routes from "./estandar/user/user_routes";
import auth_routes from "./estandar/auth/auth_routes";
import post_routes from "./estandar/post/post_routes";
import chat_routes from "./estandar/chat/chat_routes";
import offers_routes from "./estandar/offer/offer_routes";
import worker_routes from "./estandar/worker/worker_routes";
import comment_routes from "./estandar/comment/comment_routes";
import service_routes from "./estandar/service/service_routes";
import category_routes from "./estandar/category/category_routes";
import notification_routes from "./estandar/notification/notification_routes";
import catalog_routes from "./estandar/catalog/catalog_routes";
import media_routes from "./estandar/media/media_routes";
import saved_routes from "./estandar/saved/saved_routes";

// 👇 Importa rutas comunes (ping, healthcheck)
import common_routes from "./common";

// 👇 NUEVO: Importa las rutas administrativas
import admin_user_routes from "./admin/admin_user_routes";

export class AppRoutes {
  static get routes(): Router {
    const router = Router();

    // -----------------------------
    // 🔹 RUTAS API v1 (usuarios normales)
    // -----------------------------
    router.use("/api/v1/auth", auth_routes);
    router.use("/api/v1/post", post_routes);
    router.use("/api/v1/chat", chat_routes);
    router.use("/api/v1/user", user_routes);
    router.use("/api/v1/offer", offers_routes);
    router.use("/api/v1/worker", worker_routes);
    router.use("/api/v1/service", service_routes);
    router.use("/api/v1/comment", comment_routes);
    router.use("/api/v1/category", category_routes);
    router.use("/api/v1/notification", notification_routes);
    router.use("/api/v1/catalog", catalog_routes);
    router.use("/api/v1/media", media_routes);
    router.use("/api/v1/saved", saved_routes);

    // -----------------------------
    // 🔹 RUTAS ADMINISTRATIVAS
    // Solo accesibles por administradores
    // -----------------------------
    router.use("/api/v1/admin/users", admin_user_routes);

    // -----------------------------
    // 🔹 Healthcheck (GET /api/v1/ping)
    // -----------------------------
    router.use("/api/v1", common_routes);

    return router;
  }
}

export default AppRoutes;

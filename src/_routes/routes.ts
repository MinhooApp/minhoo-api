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

import { Router } from "express";

export class AppRoutes {
  static get routes(): Router {
    const apiPaths = {
      auth: "/api/v1/auth",
      post: "/api/v1/post",
      user: "/api/v1/user",
      chat: "/api/v1/chat",
      offer: "/api/v1/offer",
      worker: "/api/v1/worker",
      service: "/api/v1/service",
      comment: "/api/v1/comment",
      category: "/api/v1/category",

      notification: "/api/v1/notification",
    };
    const router = Router();

    router.use(apiPaths.auth, auth_routes);
    router.use(apiPaths.post, post_routes);
    router.use(apiPaths.chat, chat_routes);
    router.use(apiPaths.user, user_routes);
    router.use(apiPaths.offer, offers_routes);
    router.use(apiPaths.worker, worker_routes);
    router.use(apiPaths.service, service_routes);
    router.use(apiPaths.comment, comment_routes);
    router.use(apiPaths.category, category_routes);
    router.use(apiPaths.notification, notification_routes);

    return router;
  }
}

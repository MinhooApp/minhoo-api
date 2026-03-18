import Router from "express";
import TokenOptional from "../../../libs/middlewares/optional_jwt";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import {
  create_group_join_request,
  cancel_group_join_request,
  create_group_invite_code,
  create_group,
  delete_group,
  group_access,
  group_messages,
  join_group_by_code,
  list_group_join_requests,
  leave_group,
  my_groups,
  remove_group_member,
  review_group_join_request,
  send_group_message,
  update_group,
} from "../../../useCases/group/_controller/controller";

const router = Router();

router.get("/my", TokenValidation(), my_groups);
router.post("/join/:code", TokenValidation(), join_group_by_code);
router.post("/", TokenValidation(), create_group);
router.get("/:groupId/access", TokenOptional(), group_access);
router.get("/:groupId/messages", TokenOptional(), group_messages);
router.post("/:groupId/messages", TokenValidation(), send_group_message);
router.post("/:groupId/invite-code", TokenValidation(), create_group_invite_code);
router.post("/:groupId/join-requests", TokenValidation(), create_group_join_request);
router.delete("/:groupId/join-requests/me", TokenValidation(), cancel_group_join_request);
router.get("/:groupId/join-requests", TokenValidation(), list_group_join_requests);
router.patch(
  "/:groupId/join-requests/:requestId",
  TokenValidation(),
  review_group_join_request
);
router.delete("/:groupId/leave", TokenValidation(), leave_group);
router.delete("/:groupId/members/:userId", TokenValidation(), remove_group_member);
router.patch("/:groupId", TokenValidation(), update_group);
router.delete("/:groupId", TokenValidation(), delete_group);

export default router;

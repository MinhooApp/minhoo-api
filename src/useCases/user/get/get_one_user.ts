import { Request, Response } from "express";
import User from "../../../_models/user/user";

export const get_one_user = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const user = await User.findOne({
      where: { id },
      attributes: [
        "id",
        "email",
        "available",
        "disabled",
        "auth_token",
        "role",
        "createdAt",
        "updatedAt"
      ],
    });

    if (!user) {
      return res.status(404).json({
        header: { success: false, authenticated: true },
        messages: ["User not found"],
      });
    }

    return res.json({
      header: { success: true, authenticated: true, messages: ["no incidents"] },
      body: { user },
    });
  } catch (error) {
    console.error("Error in get_one_user:", error);
    return res.status(500).json({
      header: { success: false, authenticated: true },
      messages: ["Internal server error"],
    });
  }
};

export default get_one_user;

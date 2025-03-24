import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
  sendNotification,
} from "../_module/module";

export const follow = async (req: Request, res: Response) => {
  const { userId } = req.body;

  try {
    const response = await followerRepo.toggleFollow(userId, req.userId);
    const myData = await repository.get(req.userId);
    if (response) {
      await sendNotification({
        followerId: req.userId,
        userId: userId,
        interactorId: req.userId,
        type: "follow",
        message: `${myData!.name} ${myData!.last_name} started following you`,
      });
    }

    return formatResponse({
      res: res,
      success: true,
      body: { following: response },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

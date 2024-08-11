import {
  Request,
  Response,
  formatResponse,
  repository,
  postRepository,
  fs,
  uploadFile,
  sendNotification,
} from "../_module/module";
export const add = async (req: Request, res: Response) => {
  try {
    var upload = uploadFile({
      route: "/uploads/comment",
      file: "media_url",
      maxFiles: 1,
      is_img: true,
    });
    upload(req, res, async function (err) {
      var file: any = [];
      file = req.files;
      const now = new Date(new Date().toUTCString());
      req.body.created_date = now;
      try {
        //Si existe el archivo, lo agrego al body
        if (file && file.media_url) {
          req.body.media_url = file.media_url[0].path.replace(
            "src\\public\\",
            "\\"
          );
        }
        req.body.userId = req.userId;
     const comment=   await repository.add(req.body);
        const post = await postRepository.get(req.body.postId);

        await sendNotification({
          userId: post?.userId,
          interactorId: req.userId,
          postId: post?.id,
          commentId: comment.id,
          type: "comment",
          message: `Commented: ${req.body.comment}`, 
        });
        return formatResponse({ res: res, success: true, body: { post } });
      } catch (error: any) {
        if (file.media_url) {
          //Si existe el archivo, lo elimino
          const filePath = file.media_url[0].path;
          fs.unlink(filePath, (err: any) => {
            if (err) {
              console.error(err);
            }
          });
        }
        return formatResponse({
          res: res,
          success: false,
          message: error.errors[0].message,
        });
      }
    });
  } catch (e) {
    return formatResponse({ res: res, success: false, message: e });
  }
};

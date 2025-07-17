import {
  Request,
  Response,
  formatResponse,
  repository,
  sendEmail,
  socket,
  sendNotification,
} from "../_module/module";

export const add = async (req: Request, res: Response) => {
  try {
    const body = req.body;
    body.workerId = req.workerId;
    const now = new Date(new Date().toUTCString());
    req.body.offer_date = now;
    const offer = await repository.add(body);
    const response = await repository.get(offer.id);

    socket.emit("offers", offer);
    await sendNotification({
      userId: response!.service.userId,
      interactorId: req.userId,
      serviceId: offer.serviceId,
      offerId: offer.id,
      type: "postulation",
      message: `Sent you a new offer!`,
    });
    //SEND EMAIL
    const emailParams = {
      subject: "There is an applicant for your offer",
      email: response!.service.client.email,
      htmlPath: "./src/public/html/email/send_offer_emmail.html",
      replacements: [
        {
          code: "@@name",
          name: `${response!.service!.client.name} ${
            response!.service!.client.last_name
          }`,
        },
      ],
    };
    sendEmail(emailParams);
    return formatResponse({
      res: res,
      success: true,
      body: { offer: response },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

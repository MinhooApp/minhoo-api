import {
  Request,
  Response,
  formatResponse,
  repository,
  serviceRepository,
  sendEmail,
  sendNotification,
} from "../_module/module";
import {
  findByEmail,
  findById,
} from "../../../repository/auth/auth_repository";
import { error } from "console";

export const removeOffer = async (req: Request, res: Response) => {
  const { offerId } = req.params;
  try {
    const offer = await repository.get(offerId);
    if (offer == null) {
      return formatResponse({
        res: res,
        success: false,
        message: "Offer not found.",
        code: 400,
      });
    } else {
      await serviceRepository.removeWorker(offer.serviceId, offer.workerId);
      await repository.update(offerId, { accepted: false });
      const service = await serviceRepository.get(offer!.serviceId);

      //SEND EMAIL
      const emailParams = {
        subject: "Application Cancelled",
        email: service!.client.email,
        htmlPath:
          "./src/public/html/email/offer_canceled_by_woorker_email.html",
        replacements: [
          {
            code: "@@name",
            name: `${service!.client.name} ${service!.client.last_name}`,
          },
        ],
      };

      await sendNotification({
        userId: service!.userId,
        interactorId: req.userId,
        serviceId: parseInt(offer!.serviceId),
        type: "applicationCanceled",
        message: `Application Canceled`,
      });
      await sendEmail(emailParams);
      return formatResponse({
        res: res,
        success: true,
        body: { service },
      });
    }
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

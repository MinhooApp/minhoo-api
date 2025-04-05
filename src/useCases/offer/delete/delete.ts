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
        email: offer.offerer.personal_data.email,
        htmlPath:
          "./src/public/html/email/offer_canceled_by_woorker_email.html",
        replacements: [
          {
            code: "@@name",
            name: `${offer.offerer.personal_data.name} ${offer.offerer.personal_data.last_name}`,
          },
        ],
      };

      await sendNotification({
        userId: offer.offerer.personal_data.id,
        interactorId: req.userId,
        serviceId: parseInt(offer!.serviceId),
        type: "applicationCanceled",
        message: "has withdrawn your candidacy",
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

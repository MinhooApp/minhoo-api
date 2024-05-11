import Offer from '../../_models/offer/offer';
import { offerInclude } from './offer_includes';
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const add = async (body: any) => {
    const offer = await Offer.create(body);

    return offer;
}

export const gets = async () => {
    const offer = await Offer.findAll({ where: {}, include: offerInclude, attributes: { exclude: excludeKeys }, order: [["offer_date", "DESC"]] });
    return offer;
}
export const getsByService = async (serviceId: any) => {
    const offer = await Offer.findAll({ where: { serviceId: serviceId }, include: offerInclude, attributes: { exclude: excludeKeys }, order: [["offer_date", "DESC"]] });
    return offer;
}
export const get = async (id: any) => {
    const offer = await Offer.findOne({ where: { id: id }, include: offerInclude, attributes: { exclude: excludeKeys }, order: [["offer_date", "DESC"]] });
    return offer;
}

export const update = async (id: any, body: any) => {
    const offerTemp = await Offer.findByPk(id);
    const offer = await offerTemp?.update(body);
    return offer;

}

export const deleteoffer = async () => {


    const offer = await Offer.update({

    }, { where: {} });
    return offer;

}
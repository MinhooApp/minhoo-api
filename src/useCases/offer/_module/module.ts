import { io } from "socket.io-client";
import { Request, Response } from 'express';
import { formatResponse } from '../../_response/format_response';
import * as repository from '../../../repository/offer/offer_repository';
import * as serviceRepository from '../../../repository/service/service_repository';
import Offer from '../../../_models/offer/offer';
const socket = io(process.env.URL_SOCKET || '');
export {
    Request, Response, formatResponse, repository, serviceRepository, socket, Offer
}

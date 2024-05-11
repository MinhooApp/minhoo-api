
import { Socket } from 'socket.io';
import Offer from '../_models/offer/offer';
import Service from '../_models/service/service';
import Message from '../_models/chat/message';
export const socketController = (socket: Socket) => {
    console.log(`Cliente conectado ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`Cliente desconectado ${socket.id}`);

    });

    //socket.emit emits to the user who generates the action
    //socket.broadcast.emit emit all user
    //////////////////////Services////////////////////////
    socket.on("services", (service: Service) => {
        socket.broadcast.emit("services", service);
        // console.log(service)
    });

    //////////////////////Offer////////////////////////
    socket.on("offers", (offer: Offer) => {
        socket.broadcast.emit(`offers/${offer.serviceId}`, offer);
        // console.log(service)
    });
    ////////////////////////////Chat///////////////
    socket.on("chat", (message: Message) => {

        //socket.emit(`chat/${message.chatId}`, message)//emits to the user who generates the action
        socket.broadcast.emit(`chat/${message.chatId}`, message)//emit all user
        // console.log({ "emit": message });
    });




}
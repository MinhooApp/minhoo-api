import { Socket } from "socket.io";
import Offer from "../_models/offer/offer";
import Service from "../_models/service/service";
import Message from "../_models/chat/message";
import Notification from "_models/notification/notification";
export const socketController = (socket: Socket) => {
  console.log(`Cliente conectado ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`Cliente desconectado ${socket.id}`);
  });

  //socket.emit emits to the user who generates the action
  //socket.broadcast.emit emit all user
  //////////////////////Services////////////////////////
  socket.on("services", (service: Service) => {
    socket.broadcast.emit("services", service);
    console.log("emitiendo");
  });

  //////////////////////Offer////////////////////////
  socket.on("offers", (offer: Offer) => {
    socket.broadcast.emit(`offers/${offer.serviceId}`, offer);
    console.log("emitiendo");
  });
  ////////////////////////////Chat///////////////
  socket.on("chats", (userId: Number) => {
    //socket.emit(`chat/${message.chatId}`, message)//emits to the user who generates the action
    socket.broadcast.emit(`chats/${userId}`); //emit all user
    console.log("emitiendo chats");
  });
  socket.on("chat", (message: Message) => {
    //socket.emit(`chat/${message.chatId}`, message)//emits to the user who generates the action
    socket.broadcast.emit(`chat/${message.chatId}`); //emit all user
    console.log("emitiendo");
  });

  //////////////////////Nottification////////////////////////
  socket.on("notification", (notification: Notification) => {
    socket.broadcast.emit(`notification/${notification.userId}`, notification);

    console.log(`emitiendo ${notification}`);
  });
};

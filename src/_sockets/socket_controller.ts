
export const socketController = (socket: any) => {
    console.log(`Cliente conectado ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`Cliente desconectado ${socket.id}`);

    });
    socket.on("test", (msg: any) => {
        console.log(msg)
    });
    socket.on("message", (msg: any) => {
        /* setInterval(() => {
             socket.broadcast.emit("message", { "Usuario": "asas" })
         }, 1000);*//// interval emit
        socket.emit("message", { "Usuario": socket.id })//emit one user
        socket.broadcast.emit("message", { "Usuario": socket.id })//emit all user
        console.log(msg);
    });

    //////////////////////Services////////////////////////
    socket.on("services", (service: any) => {
        console.log(service)
        socket.broadcast.emit("services", service);
    });

    socket.on("service", (service: any) => {
        console.log(service)
        socket.broadcast.emit("service/" + service.id, service);
    });

    socket.on("service/u", (service: any) => {
        console.log("holalalala")
        socket.broadcast.emit("service/u/" + service[0].userId, service);
    });

    ////////////////////////////Chat///////////////
    socket.on("message", (chat: any) => {
        //socket.emit(`message/${chat.id}`, chat)//emit all user// interval emit
        socket.emit(`message/${chat.id}`, { "Usuario": socket.id })//emit genere action
        socket.broadcast.emit(`message/${chat.id}`, chat)//emit all user
        console.log(chat);
    });
}
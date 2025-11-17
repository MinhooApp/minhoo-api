import { Socket } from 'socket.io';
export function test(socket: Socket, data: any) {
    socket.emit("test",
        `Emitiendo: ${data}`//
    );
    socket.broadcast.emit("test",
        `Emitiendo: ${data}`//
    );

}
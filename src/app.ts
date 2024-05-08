import dotenv from 'dotenv';
import { createServer } from 'http';
import Server from './_server/server';
import { AppRoutes } from './_routes/routes';
dotenv.config();

const server = new Server({
    port: parseInt(process.env.PORT!)
});
const httpServer = createServer(server.app);
//  WssService.initWss({ server: httpServer });

server.setRoutes(AppRoutes.routes);
httpServer.listen(parseInt(process.env.PORT!), () => {
    console.log(`Server running on port: ${process.env.PORT!}`);
})
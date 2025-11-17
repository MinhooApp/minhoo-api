import dotenv from 'dotenv';
import { createServer } from 'http';
import Server from './_server/server';
import { AppRoutes } from './_routes/routes';
dotenv.config();

var port = parseInt(process.env.PORT!)
const server = new Server({ port: port });

server.listen();
server.setRoutes(AppRoutes.routes);
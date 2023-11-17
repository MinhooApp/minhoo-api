import dotenv from 'dotenv';
import Server from './_server/server';

dotenv.config();

const server = new Server();

server.listen();
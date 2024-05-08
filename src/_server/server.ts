import cors from 'cors';
import sequelize from '../_db/connection';
import * as t from "../_models/association";
import express, { Router, Application } from 'express';
import user_routes from "../_routes/estandar/user/user_routes";
import auth_routes from "../_routes/estandar/auth/auth_routes";
import post_routes from "../_routes/estandar/post/post_routes";
import offers_routes from "../_routes/estandar/offer/offer_routes";
import worker_routes from '../_routes/estandar/worker/worker_routes';
import comment_routes from "../_routes/estandar/comment/comment_routes";
import service_routes from "../_routes/estandar/service/service_routes";
import category_routes from "../_routes/estandar/category/category_routes";
import chat_routes from "../_routes/estandar/chat/chat_routes";
console.log(t);

interface Options {
    port: number;
    public_path?: string;
}
class Server {

    public readonly app = express();
    private serverListener?: any;
    private readonly port: number;
    private readonly publicPath: string;
    private io: Application;
    private server: Application;
    //private host: string;


    constructor(options: Options) {
        const { port, public_path = 'public' } = options;
        this.port = port;
        this.publicPath = public_path;
        this.server = require('http').createServer(this.app);
        this.io = require('socket.io')(this.server);
        this.middlewares();
        this.dbConnection();
        this.configure();


    }


    async dbConnection() {
        try {
            // Se usa para crear las tablas de manera inicial
            await sequelize.sync({ force: false });
            console.log('✔️  Database Online !!!')
        } catch (error: any) {
            console.log(error)
            throw new Error('🚫 ' + error)
        }
    }


    middlewares() {
        //Cors
        this.app.use(cors())
        //Body Read
        this.app.use(express.json())

        //Public Folder
        this.app.use(express.static('src/public'))




    }

    public setRoutes(ruoter: Router) {
        this.app.use(ruoter);
    }


    private configure() {

        //* Middlewares
        this.app.use(express.json()); // raw
        this.app.use(express.urlencoded({ extended: true })); // x-www-form-urlencoded

        //* Public Folder
        this.app.use(express.static(this.publicPath));



    }



    /////////////////////////////////
    listen() {
        this.app.listen(this.port, () => {
            console.log("Server run in the port: " + this.port);
        });
    }


}

export default Server;







/*import cors from 'cors';
import sequelize from '../_db/connection';
import express, { Router, Application } from 'express';



interface Options {
    port: number;
    public_path?: string;
}
class Server {

    public readonly app = express();
    private serverListener?: any;
    private readonly port: number;
    private readonly publicPath: string;
    private io: Application;
    private server: Application;




    constructor(options: Options) {
        const { port, public_path = 'public' } = options;
        this.port = port;
        this.publicPath = public_path;
        this.server = require('http').createServer(this.app);
        this.io = require('socket.io')(this.server);
        this.middlewares();
        this.dbConnection();
        this.configure();


    }

    async dbConnection() {
        try {
            // Se usa para crear las tablas de manera inicial
            await sequelize.sync({ force: false });
            console.log('✔️  Database Online !!!')
        } catch (error: any) {
            console.log(error)
            throw new Error('🚫 ' + error)
        }
    }


    middlewares() {
        //Cors
        this.app.use(cors())
        //Body Read
        this.app.use(express.json())

        //Public Folder
        this.app.use(express.static('src/public'))

    }
    public setRoutes(ruoter: Router) {
        this.app.use(ruoter);
    }


    private configure() {

        //* Middlewares
        this.app.use(express.json()); // raw
        this.app.use(express.urlencoded({ extended: true })); // x-www-form-urlencoded

        //* Public Folder
        this.app.use(express.static(this.publicPath));



    }


    /////////////////////////////////
    async start() {
        this.serverListener = this.server.listen(this.port, () => {
            console.log(`Server running on port ${this.port}`);
        });

    }

}

export default Server; 
*/
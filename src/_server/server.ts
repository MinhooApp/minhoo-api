import cors from 'cors';
import sequelize from '../_db/connection';
import * as t from "../_models/association";
import express, { Application } from 'express';
import auth_routes from "../_routes/estandar/auth/auth_routes";
import post_routes from "../_routes/estandar/post/post_routes";
import comment_routes from "../_routes/estandar/comment/comment_routes";
console.log(t);

class Server {

    private app: Application;
    private server: Application;
    private port: string;
    //private host: string;
    private apiPaths = {
        auth: "/api/v1/auth",
        post: "/api/v1/post",
        comment: "/api/v1/comment"




    }
    //////////////admin routes/////////
    private apiAdminPaths = {




    }

    constructor() {
        this.app = express();
        this.port = process.env.PORT!;
        //this.host = "192.168.0.10";
        this.server = require('http').createServer(this.app);
        //Init Methods
        this.dbConnection();
        this.middlewares();
        this.routes();

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

    routes() {


        this.app.use(this.apiPaths.auth, auth_routes);
        this.app.use(this.apiPaths.post, post_routes);
        this.app.use(this.apiPaths.comment, comment_routes);

    }




    /////////////////////////////////
    listen() {
        this.app.listen(this.port, () => {
            console.log("Server run in the port: " + this.port);
        });
    }


}

export default Server;
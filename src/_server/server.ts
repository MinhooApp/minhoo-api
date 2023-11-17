import cors from 'cors';
import sequelize from '../_db/connection';
import * as t from "../_models/association";
import express, { Application } from 'express';
import auth_routes from "../_routes/estandar/auth/auth_routes";
console.log(t);

class Server {

    private app: Application;
    private server: Application;
    private port: string;
    //private host: string;
    private apiPaths = {
        auth: "/api/v1/auth"


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
        //this.app.use(bodyParser.text({ type: '/', }));// support encoded bodies
        //Body Read
        this.app.use(express.json())

        //Public Folder
        this.app.use(express.static('src/public'))

        //File Uploads///

        // Fileupload - Carga de archivos
        /* this.app.use(fileUpload({
             useTempFiles: true,
             tempFileDir: '/tmp/',
             createParentPath: true,
 
 
         }));*/




    }

    routes() {


        this.app.use(this.apiPaths.auth, auth_routes);

    }




    /////////////////////////////////
    listen() {
        this.app.listen(this.port, () => {
            console.log("Server run in the port: " + this.port);
        });
    }


}

export default Server;
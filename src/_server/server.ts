import cors from 'cors';
import sequelize from '../_db/connection';
import * as t from "../_models/association";
import express, { Router, Application } from 'express';

console.log(t);

interface Options {
    port: number;
    public_path?: string;
}
class Server {

    public readonly app = express();
    private readonly port: number;
    private readonly publicPath: string;

    //private host: string;


    constructor(options: Options) {
        const { port, public_path = 'public' } = options;
        this.port = port;
        this.publicPath = public_path;

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
            console.log('Servidor corriendo en puerto', this.port);
        });
    }


}

export default Server;


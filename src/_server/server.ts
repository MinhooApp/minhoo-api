import cors from "cors";
import sequelize from "../_db/connection";
import { Server as HttpServer } from "http";
import * as t from "../_models/association";
import { Server as SocketIOServer } from "socket.io";
import express, { Router, Application } from "express";
import { socketController } from "../_sockets/socket_controller";

console.log(t);

interface Options {
  port: number;
  public_path?: string;
}
class Server {
  public readonly app = express();
  private server: HttpServer;
  private io: SocketIOServer;
  private readonly port: number;
  private readonly publicPath: string;

  //private host: string;

  constructor(options: Options) {
    const { port, public_path = "public" } = options;
    this.port = port;
    this.publicPath = public_path;
    this.server = new HttpServer(this.app);
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: "*",
      },
    });
    this.middlewares();
    this.dbConnection();
    this.configure();

    /////////Sockets/////////////socketController
    this.sockets();
  }

  async dbConnection() {
    try {
      // Se usa para crear las tablas de manera inicial
      await sequelize.sync({ force: false });
      console.log("✔️  Database Online !!!");
    } catch (error: any) {
      console.log(error);
      throw new Error("🚫 " + error);
    }
  }

  middlewares() {
    //Cors
    this.app.use(cors());
    //Body Read
    this.app.use(express.json());

    //Public Folder
    this.app.use(express.static("src/public"));
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

  sockets() {
    this.io.on("connection", socketController);
  }
  /////////////////////////////////
  listen() {
    this.server.listen(this.port, () => {
      console.log("Servidor corriendo en puerto", this.port);
    });
  }
}

export default Server;

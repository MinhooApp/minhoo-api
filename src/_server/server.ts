import cors from "cors";
import sequelize from "../_db/connection";
import { createServer, Server as HttpsServer } from "https";
import * as t from "../_models/association";
import { Server as SocketIOServer } from "socket.io";
import express, { Router } from "express";
import { socketController } from "../_sockets/socket_controller";
import fs from "fs";

interface Options {
  port: number;
  public_path?: string;
}

class Server {
  public readonly app = express();
  private server: HttpsServer;
  private io: SocketIOServer;
  private readonly port: number;
  private readonly publicPath: string;

  constructor(options: Options) {
    const { port, public_path = "public" } = options;
    this.port = port;
    this.publicPath = public_path;

    const key = fs.readFileSync("certs/privkey.pem");
    const cert = fs.readFileSync("certs/fullchain.pem");
    this.server = createServer({ key, cert }, this.app);

    this.io = new SocketIOServer(this.server, {
      cors: { origin: "*" },
    });

    this.middlewares();
    this.dbConnection();
    this.configure();
    this.sockets();
  }

  async dbConnection() {
    try {
      await sequelize.sync({ force: false });
      console.log("✔️  Database Online !!!");
    } catch (error: any) {
      console.error(error);
      throw new Error("🚫 " + error);
    }
  }

  middlewares() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static("src/public"));
  }

  public setRoutes(router: Router) {
    this.app.use(router);
  }

  private configure() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.static(this.publicPath));
  }

  sockets() {
    this.io.on("connection", socketController);
  }

  listen() {
    this.server.listen(this.port, () => {
      console.log(`🔐 Servidor HTTPS corriendo en puerto ${this.port}`);
    });
  }
}

export default Server;

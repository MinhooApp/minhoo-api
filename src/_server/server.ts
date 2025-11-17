import cors from "cors";
import sequelize from "../_db/connection";
import { Server as HttpServer } from "http";
import * as t from "../_models/association";
import express, { Router, Application } from "express";

console.log(t);

interface Options {
  port: number;
  public_path?: string;
}

class Server {
  public readonly app = express();
  private server: HttpServer;
  private readonly port: number;
  private readonly publicPath: string;

  constructor(options: Options) {
    const { port, public_path = "public" } = options;

    this.port = port;
    this.publicPath = public_path;

    this.server = new HttpServer(this.app);

    this.middlewares();
    this.dbConnection();
    this.configure();
  }

  async dbConnection() {
    try {
      await sequelize.sync({ force: false });
      console.log("✔️  Database Online !!!");
    } catch (error: any) {
      console.log(error);
      throw new Error("🚫 " + error);
    }
  }

  private middlewares() {
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

  listen() {
    this.server.listen(this.port, () => {
      console.log("Servidor corriendo en puerto", this.port);
    });
  }
}

export default Server;

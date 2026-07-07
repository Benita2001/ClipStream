import express from "express";
import { oauthRouter } from "./oauth";
import { clipsRouter } from "./clips";
import { campaignsRouter } from "./campaigns";
import { clippersRouter } from "./clippers";
import { walletsRouter } from "./wallets";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(oauthRouter);
  app.use(clipsRouter);
  app.use(campaignsRouter);
  app.use(clippersRouter);
  app.use(walletsRouter);
  return app;
}

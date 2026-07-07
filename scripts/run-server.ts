import * as dotenv from "dotenv";
dotenv.config();

import { createApp } from "../server/app";

const port = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`ClipStream server listening on http://localhost:${port}`);
  console.log(`Start X account linking at: http://localhost:${port}/auth/x/start?wallet_address=0xYOUR_WALLET`);
});

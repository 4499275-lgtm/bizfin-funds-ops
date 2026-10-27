import { buildServer } from "./api/server.js";
import { openDb } from "./core/db.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const dbFile = process.env.DB_FILE ?? "data/funds.db";

const db = openDb({ file: dbFile });
const app = await buildServer({ db, port, host });
await app.listen({ port, host });
// eslint-disable-next-line no-console
console.log(`bizfin-funds-ops listening on http://${host}:${port} (db: ${dbFile})`);

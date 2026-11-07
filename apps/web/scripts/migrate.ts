import { migrateDatabase } from "./lib/migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL first (see .env.example).");
await migrateDatabase(url);
console.log("Database is up to date.");

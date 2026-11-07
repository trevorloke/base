import { seedDatabase } from "./lib/seed";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL first (see .env.example).");
console.log(await seedDatabase(url));

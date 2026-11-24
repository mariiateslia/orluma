import { openDatabase } from '../server/database.js';
const db = await openDatabase();
await db.close();
console.log('PostgreSQL migrations are current.');

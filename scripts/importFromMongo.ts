/**
 * One-off copy of the old MongoDB Atlas data into Neon. Run the migration first.
 * Usage: MONGODB_URI='mongodb+srv://...' DATABASE_URL='postgresql://...' npm run import-mongo
 */
import { MongoClient } from 'mongodb';
import { pool } from './db.js';
import { importFromMongo } from './mongoImport.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Set MONGODB_URI to the old database (the same value the Render backend used).');
  process.exit(1);
}

const mongo = new MongoClient(uri);
const pg = pool();
try {
  await mongo.connect();
  await importFromMongo(mongo.db(), pg);
  console.log('Done. Sign in with an existing account to check.');
} finally {
  await mongo.close();
  await pg.end();
}

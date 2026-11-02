/**
 * Creates a host account (there is no sign-up route for hosts).
 * Usage: HOST_NAME="Host Admin" HOST_EMAIL=admin@college.edu HOST_PASSWORD='...' npm run create-host
 */
import { createNeonDb } from '../src/db/client.js';
import { createHostAccount } from '../src/services/accounts.js';
import { databaseUrl } from './db.js';

const name = process.env.HOST_NAME ?? process.env.HOST_INITIAL_NAME ?? 'Host Admin';
const email = process.env.HOST_EMAIL ?? process.env.HOST_INITIAL_EMAIL;
const password = process.env.HOST_PASSWORD ?? process.env.HOST_INITIAL_PASSWORD;

if (!email || !password) {
  console.error('Set HOST_EMAIL and HOST_PASSWORD (and optionally HOST_NAME).');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Use a host password of at least 10 characters.');
  process.exit(1);
}

const result = await createHostAccount(createNeonDb(databaseUrl()), { name, email, password });
console.log(result.created ? `Created host ${result.email}` : `A host with ${result.email} already exists; nothing changed.`);

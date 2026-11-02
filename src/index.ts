import { createApp } from './app.js';
import { createNeonDb } from './db/client.js';
import type { Bindings } from './env.js';
import { durableObjectRealtime } from './realtime/client.js';

export { CompetitionRoom } from './realtime/CompetitionRoom.js';

const app = createApp({
  db: (env) => createNeonDb(env.DATABASE_URL),
  realtime: (env, waitUntil) => durableObjectRealtime(env.COMPETITION_ROOM, waitUntil),
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;

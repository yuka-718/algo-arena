import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// An optimistic version protects a complete game command (including rating settlement).
export const arenaState = sqliteTable('arena_state', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
  state: text('state').notNull(),
});

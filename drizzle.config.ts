import { defineConfig } from 'drizzle-kit'

// Fail loudly and specifically. A bare `process.env.DATABASE_URL!` silences the
// type error but surfaces later as an opaque driver failure during `db:migrate`.
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. drizzle-kit needs it for generate/migrate. ' +
      'In Docker it comes from docker-compose.yml; locally, copy .env.example to .env.local. ' +
      'Note: `next build` does NOT need this — migrations run at container start via docker/scripts/migrate.sh.',
  )
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dbCredentials: {
    url: databaseUrl,
  },
})

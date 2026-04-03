const { randomUUID } = require('node:crypto')
const { JsonStore } = require('./jsonStore')
const { PostgresStore } = require('./postgresStore')

function getPostgresConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }

  if (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE) {
    const password = process.env.PGPASSWORD ? `:${process.env.PGPASSWORD}` : ''
    const port = process.env.PGPORT ?? '5432'
    return `postgresql://${process.env.PGUSER}${password}@${process.env.PGHOST}:${port}/${process.env.PGDATABASE}`
  }

  return ''
}

async function createStore() {
  const connectionString = getPostgresConnectionString()

  if (connectionString) {
    try {
      const store = new PostgresStore(connectionString)
      await store.initialize()
      return store
    } catch (error) {
      console.warn('PostgreSQL connection failed, falling back to local JSON storage.')
      console.warn(error.message)
    }
  }

  return new JsonStore()
}

function attachId(entry) {
  return {
    id: randomUUID(),
    ...entry,
  }
}

module.exports = {
  attachId,
  createStore,
}

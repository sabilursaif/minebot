'use strict'

const ConnectionManager = require('./connection-manager')

const manager = new ConnectionManager()

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`\nReceived ${signal}. Shutting down MineBot...`)

  try {
    await manager.stop()
    process.exitCode = 0
  } catch (error) {
    console.error('Shutdown failed:', error)
    process.exitCode = 1
  }
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

manager.on('status', status => {
  console.log('[STATUS]', JSON.stringify(status))
})

manager.on('log', entry => {
  // Future dashboard and persistent logger integration.
})

manager.connect()

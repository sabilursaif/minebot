'use strict'

const ConnectionManager = require('./connection-manager')
const createWebServer = require('./server')
const ViaProxyManager = require('./viaproxy-manager')

const manager = new ConnectionManager()
const viaProxy = new ViaProxyManager()
const web = createWebServer(manager)

let shuttingDown = false
let webStarted = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`\nReceived ${signal}. Shutting down MineBot...`)

  try {
    await manager.stop()
    await viaProxy.stop()

    if (webStarted) {
      await web.close()
      webStarted = false
    }

    console.log('[SYSTEM] MineBot shutdown complete')
    process.exitCode = ['SIGINT', 'SIGTERM'].includes(signal) ? 0 : 1
  } catch (error) {
    console.error('[SYSTEM] Shutdown failed:', error)
    process.exitCode = 1
  }
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

manager.on('status', status => {
  console.log('[STATUS]', JSON.stringify(status))
})

viaProxy.on("exit", ({ unexpected }) => {
  if (unexpected && !shuttingDown) {
    console.error("[SYSTEM] ViaProxy exited unexpectedly")
    shutdown("VIAPROXY_FAILURE")
  }
})

async function start() {
  try {
    const address = await web.listen()
    webStarted = true

    console.log(
      `[HTTP] Listening on http://${address.address}:${address.port}`
    )

    await viaProxy.start()

    if (!shuttingDown) {
      manager.connect()
    }
  } catch (error) {
    console.error('[SYSTEM] Startup failed:', error)
    await shutdown('STARTUP_FAILURE')
  }
}

start()

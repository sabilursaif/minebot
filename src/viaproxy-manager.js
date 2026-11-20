'use strict'

const { spawn } = require('node:child_process')
const { createConnection } = require('node:net')
const { createInterface } = require('node:readline')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

class ViaProxyManager extends EventEmitter {
  constructor() {
    super()

    this.java = process.env.JAVA_BIN || 'java'
    this.jarPath = path.resolve(
      process.env.VIAPROXY_JAR ||
      path.join(__dirname, '../tools/viaproxy/ViaProxy-3.4.14.jar')
    )

    this.host = '127.0.0.1'
    this.port = Number(process.env.VIAPROXY_PORT || 25568)
    this.target = process.env.MINEBOT_SERVER_ADDRESS
    this.targetVersion = process.env.VIAPROXY_TARGET_VERSION || '26.3'

    this.child = null
    this.startPromise = null
    this.stopping = false
  }

  async waitForPort(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const connected = await new Promise(resolve => {
        const socket = createConnection({
          host: this.host,
          port: this.port
        })

        socket.setTimeout(1000)

        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })

        socket.once('error', () => {
          socket.destroy()
          resolve(false)
        })

        socket.once('timeout', () => {
          socket.destroy()
          resolve(false)
        })
      })

      if (connected) return

      await new Promise(resolve => setTimeout(resolve, 250))
    }

    throw new Error('ViaProxy did not open its listening port')
  }

  start() {
    if (this.startPromise) return this.startPromise
    if (this.child) return Promise.resolve()

    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = null
    })

    return this.startPromise
  }

  startProcess() {
    if (!this.target) {
      return Promise.reject(
        new Error('MINEBOT_SERVER_ADDRESS is not configured')
      )
    }

    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      return Promise.reject(new Error('Invalid ViaProxy port'))
    }

    if (!fs.existsSync(this.jarPath)) {
      return Promise.reject(
        new Error(`ViaProxy JAR not found: ${this.jarPath}`)
      )
    }

    const args = [
      '-Xms128m',
      '-Xmx512m',
      '-XX:+UseSerialGC',
      '-jar',
      this.jarPath,
      'cli',
      '--bind-address', this.host + ':' + this.port,
      '--target-address', this.target,
      '--target-version', this.targetVersion,
      '--auth-method', 'NONE',
      '--proxy-online-mode', 'false',
      '--log-ips', 'false'
    ]

    console.log('[SYSTEM] Starting ViaProxy...')

    return new Promise((resolve, reject) => {
      const child = spawn(this.java, args, {
        cwd: path.dirname(this.jarPath),
        stdio: ['ignore', 'pipe', 'pipe']
      })

      this.child = child

      let settled = false

      const timeout = setTimeout(() => {
        fail(new Error('ViaProxy startup timed out'))
        child.kill('SIGTERM')
      }, 180000)

      const succeed = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        console.log(
          `[SYSTEM] ViaProxy ready at ${this.host}:${this.port}`
        )
        resolve()
      }

      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }

      const handleOutput = line => {
        console.log(`[ViaProxy] ${line}`)

        if (line.includes('ViaProxy started successfully!')) {
          this.waitForPort()
            .then(succeed)
            .catch(fail)
        }
      }

      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })

      stdout.on('line', handleOutput)
      stderr.on('line', handleOutput)

      child.on('error', error => {
        fail(error)
      })

      child.on('exit', (code, signal) => {
        if (!settled) {
          fail(new Error(
            `ViaProxy exited during startup (code=${code}, signal=${signal})`
          ))
        }

        if (this.child === child) this.child = null

        this.emit('exit', { code, signal, unexpected: !this.stopping })
        console.log(`[SYSTEM] ViaProxy exited (code=${code}, signal=${signal})`)
      })
    })
  }

  async stop() {
    const child = this.child
    if (!child) return

    this.stopping = true
    console.log('[SYSTEM] Stopping ViaProxy...')

    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
      }, 5000)

      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      child.kill('SIGTERM')
    })

    this.stopping = false
    this.child = null

    console.log('[SYSTEM] ViaProxy stopped')
  }
}

module.exports = ViaProxyManager

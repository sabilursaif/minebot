'use strict'

const EventEmitter = require('node:events')
const mineflayer = require('mineflayer')
const config = require('./config')

function formatReason(reason) {
  if (reason == null) return 'Unknown reason'
  if (typeof reason === 'string') return reason

  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

class ConnectionManager extends EventEmitter {
  constructor() {
    super()

    this.bot = null
    this.retryTimer = null
    this.stopPromise = null
    this.shuttingDown = false
    this.hasConnected = false
    this.reconnectAttempts = 0
    this.totalReconnects = 0
    this.connectionId = 0

    this.state = {
      status: 'disconnected',
      username: config.bot.username,
      proxy: `${config.bot.host}:${config.bot.port}`,
      version: config.bot.version,
      connectedAt: null,
      position: null,
      health: null,
      food: null,
      foodSaturation: null,
      dimension: null,
      deathCount: 0,
      lastDeathAt: null,
      reconnectAttempts: 0,
      totalReconnects: 0,
      lastDisconnectAt: null,
      lastDisconnectReason: null,
      lastError: null
    }
  }

  getSnapshot() {
    const connectedAt = this.state.connectedAt

    return {
      ...this.state,
      uptimeSeconds: connectedAt
        ? Math.floor((Date.now() - Date.parse(connectedAt)) / 1000)
        : 0
    }
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.getSnapshot())
  }

  log(level, message, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...details
    }

    console.log(
      `[${entry.timestamp}] [${level.toUpperCase()}] ${message}`,
      Object.keys(details).length ? details : ''
    )

    this.emit('log', entry)
  }
  readStats(bot) {
    const position = bot.entity?.position

    const numberOrNull = value =>
      Number.isFinite(value) ? value : null

    const round = value =>
      Number.isFinite(value)
        ? Math.round(value * 100) / 100
        : null

    return {
      position: position
        ? {
            x: round(position.x),
            y: round(position.y),
            z: round(position.z)
          }
        : null,

      health: numberOrNull(bot.health),
      food: numberOrNull(bot.food),
      foodSaturation: numberOrNull(bot.foodSaturation),

      dimension: typeof bot.game?.dimension === 'string'
        ? bot.game.dimension
        : null
    }
  }

  syncStats(bot) {
    const stats = this.readStats(bot)

    const changed = Object.entries(stats).some(
      ([key, value]) =>
        JSON.stringify(this.state[key]) !== JSON.stringify(value)
    )

    if (changed) {
      this.update(stats)
    }
  }

  clearStatsTimer() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  startStatsPolling(bot, id) {
    this.clearStatsTimer()
    this.syncStats(bot)

    this.statsTimer = setInterval(() => {
      if (
        this.bot !== bot ||
        this.connectionId !== id ||
        this.shuttingDown
      ) {
        this.clearStatsTimer()
        return
      }

      this.syncStats(bot)
    }, 1000)

    this.statsTimer.unref?.()
  }
  connect() {
    if (this.shuttingDown || this.bot) return

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.statsTimer = null
    }

    const id = ++this.connectionId

    this.update({
      status: this.hasConnected ? 'reconnecting' : 'connecting',
      lastError: null
    })

    this.log('info', 'Connecting to Minecraft through ViaProxy', {
      proxy: this.state.proxy,
      username: this.state.username
    })

    let bot

    try {
      bot = mineflayer.createBot({
        host: config.bot.host,
        port: config.bot.port,
        username: config.bot.username,
        auth: 'offline',
        version: config.bot.version,
        connectTimeout: config.connection.connectTimeoutMs
      })
    } catch (error) {
      this.update({
        status: 'disconnected',
        lastError: error.message
      })

      this.log('error', 'Failed to create bot', {
        error: error.message
      })

      this.scheduleReconnect()
      return
    }

    this.bot = bot

    const isCurrent = () =>
      this.bot === bot && this.connectionId === id

    bot.on('login', () => {
      if (!isCurrent()) return

      this.update({ status: 'logging_in' })
      this.log('info', 'Minecraft login successful')
    })

    bot.on('spawn', () => {
      if (!isCurrent()) return

      this.hasConnected = true
      this.reconnectAttempts = 0

      this.update({
        status: 'online',
        connectedAt: this.state.connectedAt || new Date().toISOString(),
        reconnectAttempts: 0,
        ...this.readStats(bot)
      })

      this.startStatsPolling(bot, id)

      this.log('info', 'Bot spawned successfully', {
        position: this.state.position,
        dimension: this.state.dimension
      })
    })

    bot.on('health', () => {
      if (isCurrent()) this.syncStats(bot)
    })

    bot.on('death', () => {
      if (!isCurrent()) return

      const diedAt = new Date().toISOString()

      this.update({
        status: 'dead',
        health: 0,
        deathCount: this.state.deathCount + 1,
        lastDeathAt: diedAt
      })

      this.log('warn', 'Bot died', {
        position: this.state.position,
        deathCount: this.state.deathCount
      })
    })

    bot.on('game', () => {
      if (isCurrent()) this.syncStats(bot)
    })

    bot.on('kicked', reason => {
      if (!isCurrent()) return

      const message = formatReason(reason)

      this.update({ lastDisconnectReason: message })
      this.log('warn', 'Server kicked the bot', { reason: message })
    })

    bot.on('error', error => {
      if (!isCurrent()) return

      this.update({ lastError: error.message })
      this.log('error', 'Minecraft connection error', {
        error: error.message
      })
    })

    bot.on('end', reason => {
      if (!isCurrent()) return

      const message = formatReason(reason) === 'Unknown reason'
        ? this.state.lastDisconnectReason || 'Connection ended'
        : formatReason(reason)

      this.bot = null
            this.clearStatsTimer()

      this.update({
        status: this.shuttingDown ? 'stopped' : 'disconnected',
        connectedAt: null,
        position: null,
        health: null,
        food: null,
        foodSaturation: null,
        dimension: null,
        lastDisconnectAt: new Date().toISOString(),
        lastDisconnectReason: message
      })

      this.log('warn', 'Minecraft connection ended', {
        reason: message
      })

      if (!this.shuttingDown) {
        this.scheduleReconnect()
      }
    })
  }

  scheduleReconnect() {
    if (this.shuttingDown || this.retryTimer) return

    const { reconnectDelayMs, maxReconnectAttempts } = config.connection

    if (
      maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= maxReconnectAttempts
    ) {
      this.update({ status: 'failed' })
      this.log('error', 'Maximum reconnect attempts reached')
      return
    }

    this.reconnectAttempts += 1
    this.totalReconnects += 1

    const nextReconnectAt = new Date(
      Date.now() + reconnectDelayMs
    ).toISOString()

    this.update({
      status: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts,
      totalReconnects: this.totalReconnects,
      nextReconnectAt
    })

    this.log('info', 'Scheduling reconnection', {
      attempt: this.reconnectAttempts,
      delayMs: reconnectDelayMs
    })

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, reconnectDelayMs)
  }

  stop() {
    if (this.stopPromise) return this.stopPromise

    this.shuttingDown = true
    this.clearStatsTimer()
    this.stopPromise = (async () => {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }

      const bot = this.bot

      if (!bot) {
        this.update({ status: 'stopped', connectedAt: null })
        this.log('info', 'Connection manager stopped')
        return
      }

      this.update({ status: 'stopping' })
      this.log('info', 'Graceful shutdown requested')

      await new Promise(resolve => {
        let finished = false

        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          resolve()
        }

        const timeout = setTimeout(finish, 5000)

        bot.once('end', finish)

        try {
          bot.quit('MineBot shutting down')
        } catch (error) {
          this.log('error', 'Error during bot shutdown', {
            error: error.message
          })
          finish()
        }
      })

      if (this.bot === bot) {
        this.bot = null
      }

      this.update({
        status: 'stopped',
        connectedAt: null,
        position: null
      })

      this.log('info', 'Connection manager stopped')
    })()

    return this.stopPromise
  }
}

module.exports = ConnectionManager

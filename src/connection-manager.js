'use strict'

const EventEmitter = require('node:events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
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
    this.autoReconnectEnabled = true
    this.manualReconnectPending = false
    this.hasConnected = false
    this.reconnectAttempts = 0
    this.totalReconnects = 0
    this.connectionId = 0
    this.eatingBot = null
    this.navigationId = 0
    this.navigationGoal = null

    this.state = {
      status: 'disconnected',
autoReconnectEnabled: true,
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
      navigationTarget: this.navigationGoal,
      uptimeSeconds: connectedAt
        ? Math.floor((Date.now() - Date.parse(connectedAt)) / 1000)
        : 0
    }
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
      navigationTarget: this.navigationGoal,
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
 
   void this.maybeEat(bot)
 }

async maybeEat(bot, force = false) {
  if (
  this.bot !== bot ||
  this.shuttingDown ||
  this.state.status !== 'online'
) {
  return { accepted: false, error: 'Bot is not online' }
}

if (this.eatingBot === bot) {
  return { accepted: false, error: 'Bot is already eating' }
}

  const health = bot.health
  const hunger = bot.food

  // Eat when either threshold is reached.
  if (!force && health >= 16 && hunger >= 10) return

  try {
    const foods = bot.registry?.foodsArray

    if (!Array.isArray(foods)) {
  return { accepted: false, error: 'Food registry unavailable' }
}

    const foodById = new Map(
      foods.map(food => [food.id, food])
    )

    // Avoid foods with harmful effects or special behavior.
    const bannedFood = new Set([
      'rotten_flesh',
      'spider_eye',
      'poisonous_potato',
      'pufferfish',
      'chorus_fruit',
      'suspicious_stew',
      'ominous_bottle',
      'cake'
    ])

    let choices = bot.inventory.items()
      .filter(item => item && item.count > 0)
      .map(item => ({
        item,
        food: foodById.get(item.type)
      }))
      .filter(({ food }) =>
        food && !bannedFood.has(food.name)
      )

    // At full hunger, only golden apples can be eaten.
    if (hunger >= 20) {
      choices = choices.filter(({ food }) =>
        food.name === 'golden_apple' ||
        food.name === 'enchanted_golden_apple'
      )
    }

    if (choices.length === 0) {
  return { accepted: false, error: 'No suitable food available' }
}

    // Prefer food with the highest overall nutritional value.
    choices.sort((a, b) =>
      (b.food.effectiveQuality ?? 0) -
      (a.food.effectiveQuality ?? 0)
    )

    const selected = choices[0]

    this.eatingBot = bot

    this.log('info', 'Automatic eating started', {
      food: selected.food.name,
      health,
      hunger
    })

    await bot.equip(selected.item, 'hand')

    if (this.bot !== bot || this.shuttingDown) return

    await bot.consume()

    if (this.bot !== bot || this.shuttingDown) return

    this.log('info', 'Automatic eating completed', {
      food: selected.food.name,
      health: bot.health,
      hunger: bot.food
    })

    this.syncStats(bot)
    return { accepted: true, food: selected.food.name }
  } catch (error) {
    if (this.bot === bot && !this.shuttingDown) {
      this.log('warn', 'Automatic eating failed', {
        error: error.message
      })
    }
    return { accepted: false, error: error.message }
  } finally {
    if (this.eatingBot === bot) {
      this.eatingBot = null
    }
  }
}

  async eat() {
    const bot = this.bot

    if (!bot || this.state.status !== "online") {
      return { accepted: false, error: "Bot is not online" }
    }

    return this.maybeEat(bot, true)
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
    if (this.shuttingDown) return
    this.autoReconnectEnabled = true

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    this.update({ autoReconnectEnabled: true })
    if (this.bot) return

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
    bot.loadPlugin(pathfinder)

    const isCurrent = () =>
      this.bot === bot && this.connectionId === id

    bot.on('login', () => {
      if (!isCurrent()) return

      this.update({ status: 'logging_in' })
      this.log('info', 'Minecraft login successful')
    })

    bot.on('spawn', () => {
      if (isCurrent()) {
        const movements = new Movements(bot)
        movements.canDig = false
        movements.allow1by1towers = false
        movements.allowParkour = false
        movements.canOpenDoors = false
        bot.pathfinder.setMovements(movements)

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
      }
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

      if (this.shuttingDown) return

      if (this.manualReconnectPending) {
        this.manualReconnectPending = false
        this.connect()
      } else if (this.autoReconnectEnabled) {
        this.scheduleReconnect()
      }
    })
  }

    goTo(x, y, z) {
    const bot = this.bot

    if (!bot || this.state.status !== 'online' || !bot.pathfinder) {
      return { accepted: false, error: 'Bot is not online' }
    }

    if (
      ![x, y, z].every(Number.isFinite) ||
      Math.abs(x) > 30000000 ||
      Math.abs(y) > 30000000 ||
      Math.abs(z) > 30000000
    ) {
      return { accepted: false, error: 'Invalid coordinates' }
    }

    const target = {
      x: Math.floor(x),
      y: Math.floor(y),
      z: Math.floor(z)
    }

    if (this.navigationGoal) this.stopNavigation()

    const id = ++this.navigationId
    this.navigationGoal = target
    this.update({})

    this.log('info', 'Navigation started', { target })

    bot.pathfinder.goto(
      new goals.GoalNear(target.x, target.y, target.z, 1)
    ).then(() => {
      if (this.bot !== bot || this.navigationId !== id) return

      this.navigationGoal = null
      this.update({})
      this.log('info', 'Navigation completed', {
        target,
        position: this.readStats(bot).position
      })
    }).catch(error => {
      if (this.bot !== bot || this.navigationId !== id) return

      this.navigationGoal = null
      this.update({})
      this.log('warn', 'Navigation failed', {
        target,
        error: error.message
      })
    })

    return { accepted: true, target }
  }

  stopNavigation() {
    if (!this.navigationGoal) {
      return { accepted: false, error: 'No active navigation' }
    }

    const target = this.navigationGoal

    this.navigationId++
    this.navigationGoal = null
    this.update({})
    this.bot?.pathfinder?.setGoal(null)

    this.log('info', 'Navigation stopped', { target })

    return { accepted: true, target }
  }

  disconnect() {
    if (this.shuttingDown) return false
    this.autoReconnectEnabled = false
    this.manualReconnectPending = false
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.update({ autoReconnectEnabled: false })
    const bot = this.bot
    if (!bot) {
      this.clearStatsTimer()
      this.update({ status: "disconnected", connectedAt: null, position: null, health: null, food: null, foodSaturation: null, dimension: null })
      return true
    }
    this.update({ status: "disconnecting" })
    this.log("info", "Manual disconnect requested")
    try { bot.quit("Disconnected from dashboard"); return true }
    catch (error) { this.log("error", "Manual disconnect failed", { error: error.message }); return false }
  }

  reconnect() {
    if (this.shuttingDown) return false
    this.autoReconnectEnabled = true
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.update({ autoReconnectEnabled: true })
    const bot = this.bot
    if (!bot) { this.manualReconnectPending = false; this.connect(); return true }
    this.manualReconnectPending = true
    this.update({ status: "reconnecting" })
    this.log("info", "Manual reconnect requested")
    try { bot.quit("Reconnecting from dashboard"); return true }
    catch (error) { this.manualReconnectPending = false; this.log("error", "Manual reconnect failed", { error: error.message }); return false }
  }

  scheduleReconnect() {
    if (this.shuttingDown || !this.autoReconnectEnabled || this.retryTimer) return

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
    this.autoReconnectEnabled = false
    this.manualReconnectPending = false
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

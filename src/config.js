'use strict'

function getString(name, fallback) {
  const value = process.env[name]
  return value?.trim() || fallback
}

function getInteger(name, fallback, min, max) {
  const raw = process.env[name]

  if (raw === undefined || raw.trim() === '') {
    return fallback
  }

  const value = Number(raw)

  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}`
    )
  }

  return value
}

const username = getString('MINEBOT_USERNAME', 'MineBot')

if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
  throw new Error('MINEBOT_USERNAME must be 3–16 valid Minecraft username characters')
}

const config = {
  bot: {
    host: getString('MINEBOT_PROXY_HOST', '127.0.0.1'),
    port: getInteger('MINEBOT_PROXY_PORT', 25568, 1, 65535),
    username,
    version: getString('MINEBOT_VERSION', '26.1')
  },

  connection: {
    connectTimeoutMs: getInteger(
      'MINEBOT_CONNECT_TIMEOUT_MS', 30000, 1000, 120000
    ),
    reconnectDelayMs: getInteger(
      'MINEBOT_RECONNECT_DELAY_MS', 5000, 1000, 300000
    ),
    maxReconnectAttempts: getInteger(
      'MINEBOT_MAX_RECONNECT_ATTEMPTS', 0, 0, 100000
    )
  }
}

module.exports = Object.freeze({
  bot: Object.freeze(config.bot),
  connection: Object.freeze(config.connection)
})

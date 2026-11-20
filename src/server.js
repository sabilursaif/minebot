'use strict'

const crypto = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const { promisify } = require('node:util')
const express = require('express')
const { WebSocket, WebSocketServer } = require('ws')

const scrypt = promisify(crypto.scrypt)

const SESSION_COOKIE = 'minebot_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 5
const MAX_LOG_ENTRIES = 200

function parsePasswordHash(encoded) {
  if (!encoded) {
    throw new Error('MINEBOT_DASHBOARD_PASSWORD_HASH is missing. Run npm run password:setup')
  }

  const parts = encoded.split('$')

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('Dashboard password hash has an invalid format')
  }

  const [algorithm, nRaw, rRaw, pRaw, saltHex, keyHex] = parts
  const N = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)

  if (
    algorithm !== 'scrypt' ||
    N !== 16384 ||
    r !== 8 ||
    p !== 1 ||
    !/^[a-f0-9]{32}$/i.test(saltHex) ||
    !/^[a-f0-9]{128}$/i.test(keyHex)
  ) {
    throw new Error('Dashboard password hash parameters are invalid')
  }

  return {
    N,
    r,
    p,
    salt: Buffer.from(saltHex, 'hex'),
    key: Buffer.from(keyHex, 'hex')
  }
}

async function verifyPassword(password, passwordHash) {
  if (typeof password !== 'string' || password.length > 128) {
    return false
  }

  const candidate = await scrypt(
    password,
    passwordHash.salt,
    passwordHash.key.length,
    {
      N: passwordHash.N,
      r: passwordHash.r,
      p: passwordHash.p,
      maxmem: 64 * 1024 * 1024
    }
  )

  return crypto.timingSafeEqual(candidate, passwordHash.key)
}

function readCookie(header, name) {
  if (!header) return null

  for (const item of header.split(';')) {
    const separator = item.indexOf('=')
    if (separator === -1) continue

    const key = item.slice(0, separator).trim()
    if (key === name) return item.slice(separator + 1).trim()
  }

  return null
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function originIsAllowed(request) {
  const origin = request.headers.origin
  if (!origin) return true

  try {
    const parsed = new URL(origin)
    const host = request.headers.host

    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host.toLowerCase() === String(host).toLowerCase()
    )
  } catch {
    return false
  }
}

function createWebServer(manager, options = {}) {
  if (
    !manager ||
    typeof manager.getSnapshot !== 'function' ||
    typeof manager.on !== 'function'
  ) {
    throw new TypeError('A valid connection manager is required')
  }

  const passwordHash = parsePasswordHash(
    process.env.MINEBOT_DASHBOARD_PASSWORD_HASH
  )

const host = options.host ||
  process.env.MINEBOT_HTTP_HOST ||
  '0.0.0.0'

const port = Number(
  options.port ??
  process.env.PORT ??
  process.env.MINEBOT_HTTP_PORT ??
  3000
)

  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('HTTP port must be an integer between 1 and 65535')
  }

  const app = express()
  const server = http.createServer(app)
  const sessions = new Map()
  const loginAttempts = new Map()
  const recentLogs = []

  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1)
  }

  app.disable('x-powered-by')
  app.use(express.json({ limit: '8kb', strict: true }))

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' data:; connect-src 'self' ws: wss:; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    })

    next()
  })

  function getSession(request) {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (!token) return null

    const digest = tokenDigest(token)
    const session = sessions.get(digest)

    if (!session) return null

    if (session.expiresAt <= Date.now()) {
      sessions.delete(digest)
      return null
    }

    return { digest, session }
  }

  function requireAuth(request, response, next) {
    const result = getSession(request)

    if (!result) {
      response.status(401).json({ error: 'Authentication required' })
      return
    }

    request.session = result.session
    request.sessionDigest = result.digest
    next()
  }

  function requireSameOrigin(request, response, next) {
    if (!originIsAllowed(request)) {
      response.status(403).json({ error: 'Origin not allowed' })
      return
    }

    next()
  }

  function setSessionCookie(request, response, token) {
    const secure = request.secure ||
      process.env.NODE_ENV === 'production'

    const attributes = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    ]

    if (secure) attributes.push('Secure')

    response.setHeader('Set-Cookie', attributes.join('; '))
  }

  function clearSessionCookie(request, response) {
    const secure = request.secure ||
      process.env.NODE_ENV === 'production'

    const attributes = [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0'
    ]

    if (secure) attributes.push('Secure')

    response.setHeader('Set-Cookie', attributes.join('; '))
  }

  function getLoginRecord(ip) {
    const now = Date.now()
    const previous = loginAttempts.get(ip) || []
    const recent = previous.filter(time => now - time < LOGIN_WINDOW_MS)

    loginAttempts.set(ip, recent)
    return recent
  }

  app.get('/health', (request, response) => {
    response.json({ status: 'ok' })
  })

  app.post(
    '/api/auth/login',
    requireSameOrigin,
    async (request, response) => {
      const ip = request.ip || request.socket.remoteAddress || 'unknown'
      const attempts = getLoginRecord(ip)

      if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
        response.set(
          'Retry-After',
          String(Math.ceil(
            (LOGIN_WINDOW_MS - (Date.now() - attempts[0])) / 1000
          ))
        )

        response.status(429).json({
          error: 'Too many login attempts. Try again later.'
        })
        return
      }

      const password = request.body?.password
      const valid = await verifyPassword(password, passwordHash)

      if (!valid) {
        attempts.push(Date.now())
        loginAttempts.set(ip, attempts)

        response.status(401).json({
          error: 'Incorrect password'
        })
        return
      }

      loginAttempts.delete(ip)

      const token = crypto.randomBytes(32).toString('base64url')
      const digest = tokenDigest(token)
      const expiresAt = Date.now() + SESSION_TTL_MS

      sessions.set(digest, { expiresAt })
      setSessionCookie(request, response, token)

      response.json({
        authenticated: true,
        expiresAt: new Date(expiresAt).toISOString()
      })
    }
  )

  app.get('/api/auth/session', requireAuth, (request, response) => {
    response.json({
      authenticated: true,
      expiresAt: new Date(request.session.expiresAt).toISOString()
    })
  })

  app.post(
    '/api/auth/logout',
    requireSameOrigin,
    requireAuth,
    (request, response) => {
      sessions.delete(request.sessionDigest)
      clearSessionCookie(request, response)
      response.json({ authenticated: false })
    }
  )

  app.post('/api/control/connect', requireSameOrigin, requireAuth, (request, response) => {
    manager.connect()
    response.status(202).json({ accepted: true, status: manager.getSnapshot() })
  })

  app.post('/api/control/disconnect', requireSameOrigin, requireAuth, (request, response) => {
    const accepted = manager.disconnect()
    response.status(accepted ? 202 : 409).json({ accepted, status: manager.getSnapshot() })
  })

  app.post('/api/control/reconnect', requireSameOrigin, requireAuth, (request, response) => {
    const accepted = manager.reconnect()
    response.status(accepted ? 202 : 409).json({ accepted, status: manager.getSnapshot() })
  })

  app.post("/api/control/eat", requireSameOrigin, requireAuth, async (request, response) => {
    const result = await manager.eat()
    response.status(result.accepted ? 200 : 409).json({
      ...result,
      status: manager.getSnapshot()
    })
  })

  app.post("/api/control/navigate", requireSameOrigin, requireAuth, (request, response) => {
    const { x, y, z } = request.body || {}
    const result = manager.goTo(x, y, z)
    const code = result.accepted ? 202 : result.error === "Invalid coordinates" ? 400 : 409
    response.status(code).json({ ...result, status: manager.getSnapshot() })
  })

  app.post("/api/control/navigate/stop", requireSameOrigin, requireAuth, (request, response) => {
    const result = manager.stopNavigation()
    response.status(result.accepted ? 202 : 409).json({ ...result, status: manager.getSnapshot() })
  })

  app.get('/api/status', requireAuth, (request, response) => {
    response.json(manager.getSnapshot())
  })

  app.get('/api/logs', requireAuth, (request, response) => {
    response.json({ logs: recentLogs })
  })

  const publicDirectory = path.join(__dirname, '..', 'public')

  app.use(express.static(publicDirectory, {
    index: 'index.html',
    dotfiles: 'deny',
    etag: true
  }))

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error)

    console.error('[HTTP] Request error:', error.message)

    response.status(error.status || 400).json({
      error: 'Invalid request'
    })
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false
  })

  function send(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return

    try {
      ws.send(JSON.stringify(payload))
    } catch {
      ws.terminate()
    }
  }

  function broadcast(payload) {
    for (const client of wss.clients) {
      if (client.sessionExpiresAt <= Date.now()) {
        client.close(1008, 'Session expired')
        continue
      }

      send(client, payload)
    }
  }

  const onStatus = status => {
    broadcast({ type: 'status', data: status })
  }

  const onLog = entry => {
    recentLogs.push(entry)

    if (recentLogs.length > MAX_LOG_ENTRIES) {
      recentLogs.shift()
    }

    broadcast({ type: 'log', data: entry })
  }

  manager.on('status', onStatus)
  manager.on('log', onLog)

  function rejectUpgrade(socket, status, message) {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      '\r\n'
    )
    socket.destroy()
  }

  server.on('upgrade', (request, socket, head) => {
    let pathname

    try {
      pathname = new URL(request.url, 'http://localhost').pathname
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }

    if (pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }

    if (!originIsAllowed(request)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }

    const result = getSession(request)

    if (!result) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }

    wss.handleUpgrade(request, socket, head, ws => {
      ws.sessionExpiresAt = result.session.expiresAt
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', ws => {
    send(ws, {
      type: 'initial',
      data: {
        status: manager.getSnapshot(),
        logs: [...recentLogs]
      }
    })

    ws.on('error', error => {
      console.error('[WS] Client error:', error.message)
    })
  })

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening)
        reject(error)
      }

      const onListening = () => {
        server.off('error', onError)
        resolve(server.address())
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  async function close() {
    manager.off('status', onStatus)
    manager.off('log', onLog)

    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down')
    }

    await new Promise(resolve => wss.close(resolve))

    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }

  return {
    app,
    server,
    wsServer: wss,
    host,
    port,
    listen,
    close,
    getRecentLogs: () => [...recentLogs]
  }
}

module.exports = createWebServer

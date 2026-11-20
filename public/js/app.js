'use strict'

const $ = selector => document.querySelector(selector)

const loginView = $('#login-view')
const dashboardView = $('#dashboard-view')
const loginForm = $('#login-form')
const passwordInput = $('#password')
const loginError = $('#login-error')
const loginButton = $('#login-button')

let authenticated = false
let socket = null
let reconnectTimer = null
let uptimeTimer = null
let currentStatus = null
let wsConnected = false
let logCount = 0

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  })

  let data = {}

  try {
    data = await response.json()
  } catch {
    data = {}
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`)
    error.status = response.status
    throw error
  }

  return data
}

function showLogin(message = '') {
  authenticated = false
  dashboardView.hidden = true
  loginView.hidden = false
  loginError.textContent = message
  loginError.hidden = !message
  passwordInput.value = ''
  passwordInput.focus()
  stopLiveUpdates()
}

function showDashboard() {
  authenticated = true
  loginView.hidden = true
  dashboardView.hidden = false
  loginError.hidden = true
  startUptimeClock()
}

function stopLiveUpdates() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (uptimeTimer) clearInterval(uptimeTimer)

  reconnectTimer = null
  uptimeTimer = null

  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }

  wsConnected = false
}

function setLiveState(state, label) {
  const element = $('#live-indicator')
  element.classList.remove('connected', 'disconnected')
  if (state) element.classList.add(state)
  $('#live-label').textContent = label
}

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`
  if (minutes > 0) return `${minutes}m ${remainder}s`
  return `${remainder}s`
}

function getUptimeSeconds() {
  if (!currentStatus) return 0

  if (currentStatus.connectedAt) {
    const start = Date.parse(currentStatus.connectedAt)
    if (Number.isFinite(start)) {
      return Math.max(0, Math.floor((Date.now() - start) / 1000))
    }
  }

  return currentStatus.uptimeSeconds || 0
}

function renderUptime() {
  $('#hero-uptime').textContent = currentStatus
    ? formatUptime(getUptimeSeconds())
    : '—'
}

function startUptimeClock() {
  if (uptimeTimer) clearInterval(uptimeTimer)
  renderUptime()
  uptimeTimer = setInterval(renderUptime, 1000)
}

function setText(selector, value) {
  $(selector).textContent = value
}

function renderStatus(status) {
  if (!status || typeof status !== 'object') return

  currentStatus = status
  updateControlButtons(status)

  const rawState = String(status.status || 'unknown')
  const label = rawState.replaceAll('_', ' ')
  const pill = $('#status-pill')

  pill.className = `status-pill status-${rawState}`
  setText('#status-label', label.charAt(0).toUpperCase() + label.slice(1))

  setText('#bot-name', status.username || 'MineBot')
  setText(
    '#bot-subtitle',
    status.status === 'online'
      ? 'Connected to your Minecraft server'
      : status.lastDisconnectReason || 'Waiting for server connection'
  )

  setText('#hero-reconnects', String(status.totalReconnects ?? 0))
  setText('#attempt-value', String(status.reconnectAttempts ?? 0))
  setText(
    '#attempt-note',
    status.reconnectAttempts > 0
      ? 'Waiting for the next retry'
      : 'No active retry attempts'
  )

  const health = Number.isFinite(status.health) ? status.health : null
  const food = Number.isFinite(status.food) ? status.food : null
  const saturation = Number.isFinite(status.foodSaturation)
    ? status.foodSaturation
    : null

  setText('#health-value', health === null ? '—' : health.toFixed(1).replace(/\.0$/, ''))
  setText('#food-value', food === null ? '—' : String(Math.round(food)))
  setText(
    '#health-note',
    health === null ? 'Waiting for player data' : `${Math.max(0, Math.min(20, health))} health points`
  )
  setText(
    '#food-note',
    saturation === null ? 'Food saturation: —' : `Food saturation: ${saturation.toFixed(1)}`
  )

  $('#health-bar').style.width = `${health === null ? 0 : Math.max(0, Math.min(100, health / 20 * 100))}%`
  $('#food-bar').style.width = `${food === null ? 0 : Math.max(0, Math.min(100, food / 20 * 100))}%`

  const deaths = status.deathCount ?? 0
  setText('#death-value', String(deaths))
  setText(
    '#death-note',
    status.lastDeathAt
      ? `Last death: ${new Date(status.lastDeathAt).toLocaleString()}`
      : 'No deaths recorded'
  )

  const position = status.position
  setText('#position-x', position ? Number(position.x).toFixed(2) : '—')
  setText('#position-y', position ? Number(position.y).toFixed(2) : '—')
  setText('#position-z', position ? Number(position.z).toFixed(2) : '—')

  const dimensionNames = {
    overworld: 'Overworld',
    the_nether: 'The Nether',
    the_end: 'The End'
  }
  setText(
    '#dimension-value',
    status.dimension
      ? dimensionNames[status.dimension] || status.dimension
      : '—'
  )

  setText('#detail-username', status.username || '—')
  setText('#detail-version', status.version || '—')
  setText('#detail-proxy', status.proxy || '—')
  setText(
    '#detail-disconnect',
    status.lastDisconnectAt
      ? new Date(status.lastDisconnectAt).toLocaleString()
      : 'None'
  )

  renderUptime()
  setText('#last-updated', `Updated ${new Date().toLocaleTimeString()}`)
}

function addLog(entry) {
  const list = $('#log-list')
  const empty = list.querySelector('.empty-logs')
  if (empty) empty.remove()

  const row = document.createElement('div')
  row.className = 'log-entry'

  const time = document.createElement('span')
  time.className = 'log-time'
  time.textContent = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString()
    : '—'

  const level = document.createElement('span')
  const severity = ['info', 'warn', 'error'].includes(entry.level)
    ? entry.level
    : 'info'
  level.className = `log-level log-level-${severity}`
  level.textContent = severity

  const content = document.createElement('span')
  content.className = 'log-message'
  content.append(document.createTextNode(String(entry.message || 'Event')))

  const details = { ...entry }
  delete details.timestamp
  delete details.level
  delete details.message

  if (Object.keys(details).length > 0) {
    const detailText = document.createElement('span')
    detailText.className = 'log-details'
    detailText.textContent = Object.entries(details)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' · ')
    content.append(detailText)
  }

  row.append(time, level, content)
  list.append(row)
  logCount += 1

  while (list.children.length > 100) {
    list.firstElementChild.remove()
  }

  list.scrollTop = list.scrollHeight
}

function renderLogs(logs) {
  const list = $('#log-list')
  list.replaceChildren()
  logCount = 0

  if (!Array.isArray(logs) || logs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty-logs'
    empty.textContent = 'No activity recorded yet.'
    list.append(empty)
    return
  }

  for (const entry of logs) addLog(entry)
}

function connectWebSocket() {
  if (!authenticated || socket) return

  setLiveState('', 'Connecting')

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const client = new WebSocket(`${protocol}//${location.host}/ws`)
  socket = client

  client.addEventListener('open', () => {
    wsConnected = true
    setLiveState('connected', 'Live')
  })

  client.addEventListener('message', event => {
    let message

    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }

    if (message.type === 'initial') {
      renderStatus(message.data?.status)
      renderLogs(message.data?.logs)
    } else if (message.type === 'status') {
      renderStatus(message.data)
    } else if (message.type === 'log') {
      addLog(message.data || {})
    }
  })

  client.addEventListener('close', event => {
    if (socket === client) socket = null
    wsConnected = false

    if (!authenticated) return

    if (event.code === 1008) {
      showLogin('Your dashboard session expired. Please sign in again.')
      return
    }

    setLiveState('disconnected', 'Reconnecting')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWebSocket()
    }, 2500)
  })

  client.addEventListener('error', () => {
    setLiveState('disconnected', 'Connection issue')
  })
}

async function loadDashboardData() {
  try {
    const [status, logs] = await Promise.all([
      request('/api/status'),
      request('/api/logs')
    ])

    renderStatus(status)
    renderLogs(logs.logs)
  } catch (error) {
    if (error.status === 401) {
      showLogin('Your session has expired. Please sign in again.')
      return
    }

    setLiveState('disconnected', 'API unavailable')
    console.error('[Dashboard]', error)
  }

  connectWebSocket()
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault()
  loginError.hidden = true
  loginButton.disabled = true

  try {
    await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: passwordInput.value })
    })

    passwordInput.value = ''
    showDashboard()
    await loadDashboardData()
  } catch (error) {
    loginError.textContent = error.message
    loginError.hidden = false
    passwordInput.select()
  } finally {
    loginButton.disabled = false
  }
})

$('#toggle-password').addEventListener('click', () => {
  const showing = passwordInput.type === 'text'
  passwordInput.type = showing ? 'password' : 'text'
  $('#toggle-password').setAttribute(
    'aria-label',
    showing ? 'Show password' : 'Hide password'
  )
})

$('#logout-button').addEventListener('click', async () => {
  try {
    await request('/api/auth/logout', { method: 'POST' })
  } catch (error) {
    console.error('[Dashboard] Logout:', error)
  }

  showLogin('You have been signed out.')
})

function updateControlButtons(status) {
  const state = status?.status || "disconnected"
  const busy = ["connecting", "logging_in", "reconnecting", "disconnecting", "stopping"].includes(state)

  $("#connect-button").disabled = busy || ["online", "dead"].includes(state)
  $("#disconnect-button").disabled = busy || ["disconnected", "stopped", "failed"].includes(state)
  $("#reconnect-button").disabled = busy || ["stopped"].includes(state)
}

async function controlBot(action) {
  const message = $("#control-message")
  message.hidden = false
  message.textContent = `${action} requested...`

  for (const id of ["#connect-button", "#disconnect-button", "#reconnect-button"]) {
    $(id).disabled = true
  }

  try {
    const result = await request(`/api/control/${action}`, { method: "POST" })
    if (result.status) renderStatus(result.status)
    message.textContent = `${action} request accepted.`
  } catch (error) {
    message.textContent = error.message
  } finally {
    if (currentStatus) updateControlButtons(currentStatus)
  }
}

$("#connect-button").addEventListener("click", () => controlBot("connect"))
$("#disconnect-button").addEventListener("click", () => {
  if (window.confirm("Disconnect MineBot and pause automatic reconnection?")) {
    controlBot("disconnect")
  }
})
$("#reconnect-button").addEventListener("click", () => controlBot("reconnect"))

async function initialize() {
  try {
    await request('/api/auth/session')
    showDashboard()
    await loadDashboardData()
  } catch {
    showLogin()
  }
}

initialize()

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const scrypt = promisify(crypto.scrypt)

function readHiddenPassword() {
  const input = process.stdin

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run this utility directly in a terminal')
  }

  return new Promise((resolve, reject) => {
    let password = ''

    function cleanup() {
      input.removeListener('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
    }

    function onData(buffer) {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') {
          cleanup()
          reject(new Error('Password setup cancelled'))
          return
        }

        if (char === '\r' || char === '\n') {
          cleanup()
          resolve(password)
          return
        }

        if (char === '\u007f' || char === '\b') {
          password = Array.from(password).slice(0, -1).join('')
          continue
        }

        if (char >= ' ' && char !== '\u007f') {
          password += char
        }
      }
    }

    process.stdout.write('New dashboard password (12–128 characters): ')
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function main() {
  const password = await readHiddenPassword()
  const length = Array.from(password).length

  if (length < 12 || length > 128) {
    throw new Error('Password must contain 12–128 characters')
  }

  const salt = crypto.randomBytes(16)

  const derivedKey = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })

  const hash = [
    'scrypt',
    16384,
    8,
    1,
    salt.toString('hex'),
    derivedKey.toString('hex')
  ].join('$')

  const envPath = path.join(process.cwd(), '.env')
  const prefix = 'MINEBOT_DASHBOARD_PASSWORD_HASH='

  let lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    : []

  const existing = lines.some(line => line.startsWith(prefix))

  if (existing) {
    let replaced = false

    lines = lines.flatMap(line => {
      if (!line.startsWith(prefix)) return [line]
      if (replaced) return []

      replaced = true
      return [prefix + hash]
    })
  } else {
    if (lines.length && lines[lines.length - 1] !== '') {
      lines.push('')
    }

    lines.push(prefix + hash)
  }

  const content = lines.join('\n').replace(/\n+$/, '') + '\n'
  const tempPath = `${envPath}.${process.pid}.tmp`

  fs.writeFileSync(tempPath, content, { mode: 0o600 })
  fs.renameSync(tempPath, envPath)
  fs.chmodSync(envPath, 0o600)

  console.log('Dashboard password hash saved to .env')
  console.log('File permissions: 600')
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})

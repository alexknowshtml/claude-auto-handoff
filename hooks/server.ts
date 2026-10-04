import type { EngineInterface } from 'claude-code'

// The static HTTP server that serves viewer pages on the Tailscale IP.
// Spawned once per session, lives as long as the session does.

const TAILSCALE_IP = '100.85.122.99'
const PORT = '3846'
const SERVE_ADDR = `${TAILSCALE_IP}:${PORT}`

let serverProcess: { pid: number; terminate: () => Promise<void> } | undefined

/** Start the server if not already running. Returns the serve address for viewerLink(). */
export async function startServer($: EngineInterface, pagesDir: string): Promise<string> {
  if (serverProcess) return SERVE_ADDR

  try {
    const script = `
const http = require('http')
const fs = require('fs')
const path = require('path')
const pagesDir = ${JSON.stringify(pagesDir)}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405)
    res.end('Method Not Allowed')
    return
  }

  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h1>Handoff Viewer</h1><p>Open a brief by its ID: /<id>.html</p>')
    return
  }

  if (!pathname.match(/^\/[a-f0-9-]{8,}\.html$/i)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  const file = path.join(pagesDir, pathname.slice(1))
  if (!file.startsWith(pagesDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(data)
  })
})

server.listen(${parseInt(PORT)}, '${TAILSCALE_IP}', () => {
  console.log('Handoff viewer listening on http://${SERVE_ADDR}')
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
`

    serverProcess = await $.process.spawn(['node', '-e', script], { cwd: pagesDir })
    return SERVE_ADDR
  } catch (err) {
    console.error('Failed to start server:', err)
    throw err
  }
}

/** Stop the server gracefully. */
export async function stopServer(): Promise<void> {
  if (serverProcess) {
    await serverProcess.terminate()
    serverProcess = undefined
  }
}

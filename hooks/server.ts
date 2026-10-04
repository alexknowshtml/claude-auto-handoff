// The static server for the viewer pages, run as `node -e SERVER_JS <dir> <host> <port>`. It
// serves only <name>.html files from <dir>. register.tsx starts it (the loader keeps $ in that file).

export const SERVER_JS = `
const http = require('http'), fs = require('fs'), path = require('path')
const [dir, host, port] = process.argv.slice(1)
http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
  if (req.method !== 'GET' || !/^[\\w-]+\\.html$/.test(name)) { res.writeHead(404); return res.end('Not found') }
  fs.readFile(path.join(dir, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(data)
  })
}).listen(Number(port), host, () => console.log('viewer serving http://' + host + ':' + port))
`

/** "host:port", or undefined when the value is not one. The host "tailscale" is resolved by the caller. */
export function parseAddress(v: string): { host: string; port: string } | undefined {
  const m = /^([\w.-]+):(\d{2,5})$/.exec(v.trim())
  return m ? { host: m[1]!, port: m[2]! } : undefined
}

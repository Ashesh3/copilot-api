/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars, @typescript-eslint/restrict-template-expressions */
import { readFileSync, existsSync } from "node:fs"
import { request } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { join } from "node:path"
import { createSecureContext } from "node:tls"

const CERT_DIR =
  process.env.CERT_DIR || join(import.meta.dirname ?? ".", "certs")
const UPSTREAM = { host: "127.0.0.1", port: 4141 }

function loadCert(domain) {
  const certPath = join(CERT_DIR, `${domain}.crt`)
  const keyPath = join(CERT_DIR, `${domain}.key`)
  if (!existsSync(certPath) || !existsSync(keyPath)) return null
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  }
}

const domains = ["api.anthropic.com", "claude.ai", "platform.claude.com"]
const certs = {}
const contexts = {}

for (const domain of domains) {
  const cert = loadCert(domain)
  if (cert) {
    certs[domain] = cert
    contexts[domain] = createSecureContext(cert)
    console.log(`Loaded cert for ${domain}`)
  } else {
    console.warn(`No cert found for ${domain} — skipping`)
  }
}

const defaultDomain = domains.find((d) => certs[d])
if (!defaultDomain) {
  console.error("No certificates found. Place .crt/.key files in:", CERT_DIR)
  process.exit(1)
}

const server = createHttpsServer(
  {
    ...certs[defaultDomain],
    SNICallback: (hostname, cb) => {
      console.log(
        `  SNI: ${hostname}${contexts[hostname] ? "" : " (no cert!)"}`,
      )
      cb(null, contexts[hostname] ?? null)
    },
  },
  (req, res) => {
    const host = req.headers.host ?? "unknown"
    console.log(`→ ${req.method} https://${host}${req.url}`)
    const proxy = request(
      {
        hostname: UPSTREAM.host,
        port: UPSTREAM.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstream) => {
        console.log(
          `  ← ${upstream.statusCode} ${req.method} https://${host}${req.url}`,
        )
        res.writeHead(upstream.statusCode ?? 500, upstream.headers)
        upstream.pipe(res)
      },
    )
    proxy.on("error", (err) => {
      console.error("Proxy error:", err.message)
      if (!res.headersSent) {
        res.writeHead(502)
        res.end("Bad Gateway")
      }
    })
    req.pipe(proxy)
  },
)

// Handle WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  const host = req.headers.host ?? "unknown"
  console.log(`⇡ WS UPGRADE https://${host}${req.url}`)
  const proxy = request({
    hostname: UPSTREAM.host,
    port: UPSTREAM.port,
    path: req.url,
    method: "GET",
    headers: req.headers,
  })

  proxy.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 ${proxyRes.statusMessage}\r\n`
        + Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")
        + "\r\n\r\n",
    )
    if (proxyHead.length > 0) socket.write(proxyHead)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })

  proxy.on("error", (err) => {
    console.error("WS proxy error:", err.message)
    socket.destroy()
  })

  proxy.end()
})

server.listen(443, "127.0.0.1", () => {
  console.log("HTTPS proxy listening on https://127.0.0.1:443")
  console.log(`Forwarding to http://${UPSTREAM.host}:${UPSTREAM.port}`)
  console.log("Domains:", Object.keys(certs).join(", "))
  console.log("\nMake sure your hosts file has:")
  for (const domain of Object.keys(certs)) {
    console.log(`  127.0.0.1 ${domain}`)
  }
})

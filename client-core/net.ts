// HTTP(S) for the client. A Mac that hosts a project serves it over TLS with a self-signed
// certificate; the invite carries a hash of its public key, and every client pins that key.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { connect } from 'node:tls'
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A server and, when it uses a self-signed certificate, that certificate (PEM) to trust. */
export interface Peer {
  server: string
  cert?: string | null
}

/** sha256 of the certificate's public key, base64: the same value `curl --pinnedpubkey sha256//…` takes. */
export const pinOf = (certPem: string) =>
  createHash('sha256').update(new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')

/** Pins as they appear in invites: base64url, so they survive copy and paste in a URL-like string. */
export const urlPin = (pin: string) => pin.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const stdPin = (pin: string) => pin.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(pin.length / 4) * 4, '=')

/**
 * TLS options that trust exactly `cert`. The hostname is not checked because the host's
 * address changes with the network; the chain must still lead to this exact certificate.
 */
export const trust = (cert?: string | null) => (cert ? { ca: [cert], checkServerIdentity: () => undefined } : {})

export interface Response {
  status: number
  type: string
  body: Buffer
}

export class ConnectError extends Error {}

/** One request. Network and TLS failures (including a wrong certificate) throw ConnectError. */
export function request(peer: Peer, method: string, path: string, opts: { headers?: Record<string, string>; body?: Uint8Array | string; timeoutMs?: number } = {}) {
  const url = new URL(peer.server + path)
  const https = url.protocol === 'https:'
  const options: RequestOptions = { method, headers: { ...opts.headers, ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}) }, ...(https ? trust(peer.cert) : {}) }
  return new Promise<Response>((ok, fail) => {
    const req = (https ? httpsRequest : httpRequest)(url, options, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }))
      res.on('error', e => fail(new ConnectError(e.message)))
    })
    req.setTimeout(opts.timeoutMs ?? 60_000, () => req.destroy(new Error('timed out')))
    req.on('error', e => fail(new ConnectError(e.message)))
    req.end(opts.body)
  })
}

/**
 * Fetches the certificate of an https server whose public key hash the invite carries. Nothing
 * is sent before the key is checked, so a server that fails the check never sees a code or token.
 */
export function pinnedCert(server: string, pin: string, timeoutMs = 10_000) {
  const url = new URL(server)
  return new Promise<string>((ok, fail) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 443, rejectUnauthorized: false })
    socket.setTimeout(timeoutMs, () => socket.destroy(new ConnectError('timed out')))
    socket.on('error', e => fail(new ConnectError(`can't reach ${server}: ${e.message}`)))
    socket.on('secureConnect', () => {
      const pem = new X509Certificate(socket.getPeerCertificate().raw).toString()
      socket.destroy()
      if (urlPin(pinOf(pem)) !== urlPin(stdPin(pin))) fail(new Error(`the server at ${server} is not the one in the invite (its key does not match); not joining`))
      else ok(pem)
    })
  })
}

/**
 * This Mac's TLS identity for hosting, made once and kept in `dir`. Undefined when no
 * `openssl` is available to sign the certificate (hosting then falls back to plain HTTP).
 */
export function hostIdentity(dir: string): { key: string; cert: string } | undefined {
  const keyFile = join(dir, 'key.pem'), certFile = join(dir, 'cert.pem')
  if (!existsSync(certFile)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      execFileSync('openssl', ['req', '-new', '-x509', '-key', keyFile, '-out', certFile, '-days', '3650', '-subj', '/CN=synchack'], { stdio: 'ignore' })
    } catch {
      return undefined
    }
  }
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') }
}

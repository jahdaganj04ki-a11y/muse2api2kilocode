import * as net from "net"

/** True when nothing is listening on the port yet. */
export function portIsFree(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (free: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(false))
    socket.once("timeout", () => finish(true))
    socket.once("error", () => finish(true))
    socket.connect(port, host)
  })
}

/** First free port at or after `start`, or `start` itself when auto-increment is off. */
export async function pickPort(host: string, start: number, auto: boolean, attempts = 30): Promise<number> {
  if (!auto) return start
  for (let offset = 0; offset < attempts; offset++) {
    const port = start + offset
    // eslint-disable-next-line no-await-in-loop
    if (await portIsFree(host, port)) return port
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, host, () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : start))
    })
  })
}

// Test-only preload (`node --import ./test/signal-seam.ts`): the daemon sends
// itself SIGTERM at one exact point in its startup, so a test can land in a
// window instead of racing for it. FROND_EAR_TEST_SIGTERM_AT picks the point:
//
//   bind   right after the control socket is bound (a unix bind is synchronous
//          inside listen(), so the file exists and accepts connections), which
//          is the moment a supervisor or second process can first see it
//   probe  while the daemon probes a socket file left at its path, before it
//          binds; the probe waits until the signal has been dispatched, so the
//          daemon's handler runs inside the wait
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const at = process.env.FROND_EAR_TEST_SIGTERM_AT;
const socketPath = process.env.FROND_EAR_SOCKET ?? "";

if (at === "bind") {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (
    this: net.Server,
    ...args: unknown[]
  ): net.Server {
    const server = (listen as (...a: unknown[]) => net.Server).apply(
      this,
      args,
    );
    if (args[0] === socketPath) {
      process.kill(process.pid, "SIGTERM");
    }
    return server;
  };
} else if (at === "probe") {
  // Node dispatches a signal by calling process.emit(signal) from the event
  // loop; seeing that emit means every SIGTERM listener has run.
  let dispatched: () => void = () => undefined;
  const sigterm = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const emit = process.emit;
  process.emit = function (this: NodeJS.Process, ...args: unknown[]) {
    const result = (emit as (...a: unknown[]) => boolean).apply(this, args);
    if (args[0] === "SIGTERM") {
      dispatched();
    }
    return result;
  } as typeof process.emit;
  const connect = net.connect;
  net.connect = function (...args: unknown[]): net.Socket {
    if (args[0] !== socketPath) {
      return (connect as (...a: unknown[]) => net.Socket)(...args);
    }
    const socket = new net.Socket();
    process.kill(process.pid, "SIGTERM");
    void sigterm.then(() => socket.connect(socketPath));
    return socket;
  } as typeof net.connect;
  // server.ts imports `connect` by name; refresh the ESM named exports.
  syncBuiltinESMExports();
}

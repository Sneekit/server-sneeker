import net from 'node:net';

// Minimal Source-RCON client for servers that don't echo the request id.
//
// Why this exists: Palworld replies to a command with packet id 0 rather than
// mirroring the id we sent. rcon-client correlates replies to requests by that
// id, so every send() hangs until it times out ("Timeout for packet id N")
// even though the server answered correctly. Its auth handshake IS standard
// (type 2 response, id mirrored), so only the reply matching is the problem.
//
// This client correlates by arrival order instead: sends are serialized, and
// each reply goes to the oldest outstanding request. That is safe precisely
// because we never have more than one command in flight.
//
// Ark keeps using rcon-client (see serverManager.js) — it is well-behaved, and
// its shutdown quirks are already handled there.

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXEC = 2;

function encode(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + bodyBuf.length);
  buf.writeInt32LE(10 + bodyBuf.length, 0); // size excludes the size field
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length); // body + packet null terminators
  return buf;
}

/**
 * Connect and authenticate. Resolves { send, destroy }.
 * `send` resolves with the server's reply text; `destroy` drops the socket.
 */
export function connectLite({ host, port, password, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    sock.setNoDelay(true);

    let buf = Buffer.alloc(0);
    const waiters = []; // FIFO; one entry per in-flight request
    let nextId = 1;
    let closed = false;

    const fail = (err) => {
      closed = true;
      while (waiters.length) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        w.reject(err);
      }
    };

    const enqueue = () =>
      new Promise((res, rej) => {
        const w = { resolve: res, reject: rej };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          rej(new Error(`RCON timed out after ${timeout}ms waiting for a reply.`));
        }, timeout);
        waiters.push(w);
      });

    const deliver = (packet) => {
      const w = waiters.shift();
      if (!w) return; // unsolicited packet — nothing to correlate it to
      clearTimeout(w.timer);
      w.resolve(packet);
    };

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // A single TCP segment may carry several packets, or half of one.
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (size < 10 || buf.length < 4 + size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + size - 2).toString('utf8');
        buf = buf.subarray(4 + size);
        deliver({ id, type, body });
      }
    });

    sock.on('error', (err) => {
      if (!closed) reject(err);
      fail(err);
    });
    sock.on('close', () => fail(new Error('RCON connection closed.')));
    sock.setTimeout(timeout, () => {
      // Idle socket timeout: only fatal if something is actually waiting.
      if (waiters.length) fail(new Error('RCON socket went idle while awaiting a reply.'));
    });

    sock.on('connect', async () => {
      try {
        const pending = enqueue();
        sock.write(encode(nextId++, TYPE_AUTH, password));
        const reply = await pending;
        // Source RCON signals a bad password with id -1.
        if (reply.type === TYPE_AUTH_RESPONSE && reply.id === -1) {
          throw new Error('RCON authentication failed (wrong password).');
        }
        resolve({
          async send(command) {
            if (closed) throw new Error('RCON connection is closed.');
            const p = enqueue();
            sock.write(encode(nextId++, TYPE_EXEC, command));
            const res = await p;
            return res.body;
          },
          destroy() {
            closed = true;
            if (!sock.destroyed) sock.destroy();
          },
        });
      } catch (err) {
        if (!sock.destroyed) sock.destroy();
        reject(err);
      }
    });
  });
}

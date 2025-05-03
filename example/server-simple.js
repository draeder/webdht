/**
 * Ultra-simple signaling server for WebDHT
 * Core functionality only - no statistics tracking
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use('/', express.static(path.join(__dirname)));
app.use('/src', express.static(path.join(__dirname, '..', 'src')));
app.use('/transports', express.static(path.join(__dirname, '..', 'transports')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const peers = new Map();

const stats = {
  interval: {
    messages: { total: 0, inbound: 0, outbound: 0 },
    signals: { offer: 0, answer: 0, candidate: 0, other: 0 },
    errors: 0,
    successfulRelays: 0
  },
  lifetime: {
    messages: { total: 0, inbound: 0, outbound: 0 },
    signals: { offer: 0, answer: 0, candidate: 0, other: 0 },
    errors: 0,
    successfulRelays: 0
  }
};

wss.on('connection', (ws) => {
  console.log('New connection');
  let peerId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'register' && data.peerId) {
        peerId = data.peerId;
        const isDuplicate = peers.has(peerId);
        peers.set(peerId, ws);

        console.log(`Registered: ${peerId}${isDuplicate ? ' (reconnection)' : ''}`);

        const peerList = Array.from(peers.keys()).filter(id => id !== peerId);
        ws.send(JSON.stringify({
          type: 'registered',
          peerId,
          peers: peerList
        }));

        if (!isDuplicate) {
          Array.from(peers.entries())
            .filter(([existingId]) => existingId !== peerId)
            .forEach(([existingId, peerWs]) => {
              if (peerWs.readyState === 1) {
                peerWs.send(JSON.stringify({
                  type: 'new_peer',
                  peerId
                }));
                console.log(
                  `Notified peer ${existingId.substring(0, 8)} about new peer ${peerId.substring(0, 8)}`
                );
              }
            });
        }

      } else if (data.type === 'signal' && data.target && data.signal) {
        const targetWs = peers.get(data.target);
        if (targetWs && targetWs.readyState === 1) {
          stats.interval.messages.total++;
          stats.interval.messages.outbound++;
          stats.interval.successfulRelays++;
          stats.lifetime.messages.total++;
          stats.lifetime.messages.outbound++;
          stats.lifetime.successfulRelays++;

          const signalType = data.signal.type?.toLowerCase() || 'other';
          stats.interval.signals[signalType] = (stats.interval.signals[signalType] || 0) + 1;
          stats.lifetime.signals[signalType] = (stats.lifetime.signals[signalType] || 0) + 1;

          targetWs.send(JSON.stringify({
            type: 'signal',
            peerId,
            signal: data.signal
          }));

          console.log(
            `Signal ${signalType.toUpperCase()} relayed ${peerId.substring(0, 8)}→${data.target.substring(0, 8)}`
          );
        } else {
          stats.interval.errors++;
          stats.interval.messages.total++;
          stats.interval.messages.inbound++;
          stats.lifetime.errors++;
          stats.lifetime.messages.total++;
          stats.lifetime.messages.inbound++;

          ws.send(JSON.stringify({
            type: 'error',
            message: 'Target peer not available'
          }));
        }
      }
    } catch (err) {
      console.error('Message error:', err.message);
    }
  });

  ws.on('close', () => {
    if (peerId) {
      peers.delete(peerId);
      console.log(`Peer disconnected: ${peerId}`);
    }
  });
});

setInterval(() => {
  const intervalSeconds = 30;
  const totalMessages = stats.interval.messages.total;
  const successRate = totalMessages > 0
    ? ((stats.interval.successfulRelays / totalMessages) * 100).toFixed(1)
    : '0.0';

  const hasActivity = totalMessages > 0
    || Object.values(stats.interval.signals).some(count => count > 0)
    || stats.interval.errors > 0;

  if (hasActivity) {
    console.log(
      `[Stats] Last ${intervalSeconds}s: Messages: ${stats.interval.messages.total} ` +
      `(IN: ${stats.interval.messages.inbound}, OUT: ${stats.interval.messages.outbound}) | ` +
      `Signals: OFFER=${stats.interval.signals.offer} ANSWER=${stats.interval.signals.answer} ` +
      `CANDIDATE=${stats.interval.signals.candidate} OTHER=${stats.interval.signals.other}\n` +
      `Lifetime: Messages: ${stats.lifetime.messages.total} ` +
      `(IN: ${stats.lifetime.messages.inbound}, OUT: ${stats.lifetime.messages.outbound}) | ` +
      `Signals: OFFER=${stats.lifetime.signals.offer} ANSWER=${stats.lifetime.signals.answer} ` +
      `CANDIDATE=${stats.lifetime.signals.candidate} OTHER=${stats.lifetime.signals.other} | ` +
      `Success Rate: ${successRate}% | Errors: ${stats.interval.errors}`
    );
  }

  // Reset counters
  Object.assign(stats.interval, {
    messages: { total: 0, inbound: 0, outbound: 0 },
    signals: { offer: 0, answer: 0, candidate: 0, other: 0 },
    errors: 0,
    successfulRelays: 0
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

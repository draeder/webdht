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

// Statistics
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

// Helper to compute XOR distance between two hex IDs
function calculateXORDistance(id1, id2) {
  const buf1 = Buffer.from(id1, 'hex');
  const buf2 = Buffer.from(id2, 'hex');
  let distance = 0n;
  for (let i = 0; i < buf1.length; i++) {
    distance = (distance << 8n) | BigInt(buf1[i] ^ buf2[i]);
  }
  return distance;
}

wss.on('connection', (ws) => {
  console.log('New connection');
  let peerId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Registration: track new peer and notify closest existing peers
      if (data.type === 'register' && data.peerId) {
        peerId = data.peerId;
        const isDuplicate = peers.has(peerId);
        peers.set(peerId, ws);

        console.log(`Registered: ${peerId}${isDuplicate ? ' (reconnection)' : ''}`);

        // Find up to 3 closest peers by XOR distance
        const otherIds = Array.from(peers.keys()).filter(id => id !== peerId);
        const closest = otherIds
          .map(id => ({ id, distance: calculateXORDistance(peerId, id) }))
          .sort((a, b) => (a.distance < b.distance ? -1 : 1))
          .slice(0, 3)
          .map(p => p.id);

        // Tell this peer who to connect to
        ws.send(JSON.stringify({
          type: 'registered',
          peerId,
          peers: closest
        }));

        // Notify those peers of the newcomer
        if (!isDuplicate) {
          closest.forEach(id => {
            const peerWs = peers.get(id);
            if (peerWs?.readyState === 1) {
              peerWs.send(JSON.stringify({
                type: 'new_peer',
                peerId
              }));
              console.log(
                `Notified ${id.substring(0,8)} of new peer ${peerId.substring(0,8)}`
              );
            }
          });
        }

      // Signaling: relay SDP/candidates between peers
      } else if (data.type === 'signal' && data.target && data.signal) {
        const targetWs = peers.get(data.target);
        if (targetWs?.readyState === 1) {
          // Update stats
          stats.interval.messages.total++;
          stats.interval.messages.outbound++;
          stats.interval.successfulRelays++;
          stats.lifetime.messages.total++;
          stats.lifetime.messages.outbound++;
          stats.lifetime.successfulRelays++;

          const sigType = (data.signal.type || 'other').toLowerCase();
          if (stats.interval.signals[sigType] != null) {
            stats.interval.signals[sigType]++;
            stats.lifetime.signals[sigType]++;
          } else {
            stats.interval.signals.other++;
            stats.lifetime.signals.other++;
          }

          targetWs.send(JSON.stringify({
            type: 'signal',
            peerId,
            signal: data.signal
          }));
          console.log(
            `Relayed ${sigType.toUpperCase()} ${peerId.substring(0,8)}→${data.target.substring(0,8)}`
          );
        } else {
          // Failed relay
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
      
      // Notify all remaining peers about the disconnection
      const disconnectionMessage = {
        type: 'peer_left',
        peerId: peerId
      };
      
      for (const [remainingPeerId, remainingWs] of peers.entries()) {
        if (remainingWs.readyState === 1) { // WebSocket.OPEN
          try {
            remainingWs.send(JSON.stringify(disconnectionMessage));
            console.log(`Notified ${remainingPeerId.substring(0, 8)}... about ${peerId.substring(0, 8)}... leaving`);
          } catch (err) {
            console.error(`Failed to notify ${remainingPeerId} about peer leaving:`, err.message);
          }
        }
      }
    }
  });
});

// Periodic stats output and reset
setInterval(() => {
  const intervalSec = 30;
  const total = stats.interval.messages.total;
  const successRate = total > 0
    ? ((stats.interval.successfulRelays / total) * 100).toFixed(1)
    : '0.0';

  const hadActivity = total > 0
    || Object.values(stats.interval.signals).some(c => c > 0)
    || stats.interval.errors > 0;

  if (hadActivity) {
    console.log(
      `[Stats Last ${intervalSec}s] Msgs: ${stats.interval.messages.total}` +
      ` (IN:${stats.interval.messages.inbound} OUT:${stats.interval.messages.outbound}) | ` +
      `Signals: OFFER=${stats.interval.signals.offer}` +
      ` ANSWER=${stats.interval.signals.answer}` +
      ` CANDIDATE=${stats.interval.signals.candidate}` +
      ` OTHER=${stats.interval.signals.other}` +
      ` | Lifetime Msgs: ${stats.lifetime.messages.total}` +
      ` (IN:${stats.lifetime.messages.inbound} OUT:${stats.lifetime.messages.outbound}) | ` +
      `Lifetime Signals: OFFER=${stats.lifetime.signals.offer}` +
      ` ANSWER=${stats.lifetime.signals.answer}` +
      ` CANDIDATE=${stats.lifetime.signals.candidate}` +
      ` OTHER=${stats.lifetime.signals.other}` +
      ` | Success Rate: ${successRate}% | Errors: ${stats.interval.errors}`
    );
  }

  // Reset interval counters
  stats.interval = {
    messages: { total: 0, inbound: 0, outbound: 0 },
    signals: { offer: 0, answer: 0, candidate: 0, other: 0 },
    errors: 0,
    successfulRelays: 0
  };
}, 30000);

// Route for serving the HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Route for serving the statistics page
app.get("/stats", (req, res) => {
  res.sendFile(path.join(__dirname, "stats.html"));
});

// API endpoint to get signaling statistics
app.get("/api/stats", (req, res) => {
  const apiStats = {
    activePeers: peers.size,
    totalPeers: peers.size, // In simple server, total = active
    peerStats: {},
    summary: {
      totalBytes: 0, // Not tracked in simple server
      totalSignals: stats.lifetime.signals.offer + stats.lifetime.signals.answer + stats.lifetime.signals.candidate + stats.lifetime.signals.other,
      totalDhtSignals: 0, // Not tracked in simple server
      totalServerSignals: stats.lifetime.successfulRelays,
      averageBytes: 0,
      averageSignals: peers.size > 0 ? Math.round((stats.lifetime.signals.offer + stats.lifetime.signals.answer + stats.lifetime.signals.candidate + stats.lifetime.signals.other) / peers.size) : 0,
      averageDhtSignals: 0,
      averageServerSignals: peers.size > 0 ? Math.round(stats.lifetime.successfulRelays / peers.size) : 0
    }
  };
  
  // Add basic peer stats (limited data available in simple server)
  for (const peerId of peers.keys()) {
    apiStats.peerStats[peerId] = {
      active: true,
      byteCount: 0, // Not tracked
      signalCount: 0, // Not tracked per peer
      dhtSignalCount: 0, // Not tracked
      serverSignalCount: 0, // Not tracked per peer
      connections: {}
    };
  }
  
  res.json(apiStats);
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

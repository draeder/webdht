import WebSocket from 'ws';
import http from 'http';

const PORT = 8888;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on('connection', (ws) => {
  let nodeId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'REGISTER') {
        nodeId = msg.nodeId;
        clients.set(nodeId, ws);
        console.log(`✓ Node registered: ${nodeId.substring(0, 8)}... (${clients.size} total)`);
        ws.send(JSON.stringify({ type: 'REGISTERED' }));
        broadcast({ type: 'PEER_LIST', peers: Array.from(clients.keys()) });
        return;
      }

      if (msg.type === 'SIGNAL') {
        const target = clients.get(msg.target);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: 'SIGNAL',
            id: nodeId,
            signal: msg.signal
          }));
        }
        return;
      }

      if (msg.type === 'GET_PEERS') {
        ws.send(JSON.stringify({
          type: 'PEER_LIST',
          peers: Array.from(clients.keys()).filter(id => id !== nodeId)
        }));
        return;
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      clients.delete(nodeId);
      console.log(`✗ Node disconnected: ${nodeId.substring(0, 8)}... (${clients.size} remaining)`);
      broadcast({ type: 'PEER_LIST', peers: Array.from(clients.keys()) });
    }
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Signaling server running on wss://localhost:${PORT}`);
});

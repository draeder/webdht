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
        console.log(`✓ ${nodeId.substring(0, 8)}... joined (${clients.size} peers)`);
        ws.send(JSON.stringify({ type: 'REGISTERED' }));
        broadcast({ type: 'PEER_JOINED', peerId: nodeId });
        return;
      }

      if (msg.type === 'SIGNAL') {
        const target = clients.get(msg.target);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ type: 'SIGNAL', id: nodeId, signal: msg.signal }));
        }
      }

      if (msg.type === 'GET_PEERS') {
        ws.send(JSON.stringify({ type: 'PEERS', peers: Array.from(clients.keys()).filter(id => id !== nodeId) }));
      }
    } catch (err) {
      console.error('Parse error:', err.message);
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      clients.delete(nodeId);
      console.log(`✗ ${nodeId.substring(0, 8)}... left (${clients.size} peers)`);
      broadcast({ type: 'PEER_LEFT', peerId: nodeId });
    }
  });
});

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

server.listen(PORT, () => {
  console.log(`🚀 Signaling server on ws://localhost:${PORT}`);
});

import WebSocket, { Server } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new Server({ server });

// Track connected clients
const clients = new Map(); // nodeId -> { ws, nodeId }

wss.on('connection', (ws) => {
  let nodeId = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      // Register node
      if (message.type === 'REGISTER') {
        nodeId = message.nodeId;
        clients.set(nodeId, { ws, nodeId });
        console.log(`[REGISTER] Node ${nodeId.substring(0, 8)}... registered. Total: ${clients.size}`);
        
        // Send confirmation
        ws.send(JSON.stringify({ type: 'REGISTERED', nodeId }));
        
        // Broadcast updated peer list to all clients
        broadcastPeerList();
        return;
      }

      // Signal routing
      if (message.type === 'SIGNAL') {
        const targetId = message.target;
        const targetClient = clients.get(targetId);
        
        if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
          console.log(`[SIGNAL] Routing ${message.signal.type} from ${nodeId?.substring(0, 8)}... to ${targetId.substring(0, 8)}...`);
          targetClient.ws.send(JSON.stringify({
            type: 'SIGNAL',
            id: nodeId,
            signal: message.signal,
            viaDht: false
          }));
        } else {
          console.log(`[SIGNAL] Target ${targetId.substring(0, 8)}... not found`);
        }
        return;
      }

      // Peer list request
      if (message.type === 'GET_PEERS') {
        const peerList = Array.from(clients.keys()).filter(id => id !== nodeId);
        ws.send(JSON.stringify({ 
          type: 'PEERS',
          peers: peerList
        }));
        return;
      }

    } catch (err) {
      console.error('Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      clients.delete(nodeId);
      console.log(`[DISCONNECT] Node ${nodeId.substring(0, 8)}... disconnected. Total: ${clients.size}`);
      broadcastPeerList();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

function broadcastPeerList() {
  const peerList = Array.from(clients.keys());
  const message = JSON.stringify({
    type: 'PEER_LIST',
    peers: peerList
  });

  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server listening on port ${PORT}`);
});

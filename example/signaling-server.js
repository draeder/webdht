/**
 * WebDHT Signaling Server Example with Enhanced Connection Logic
 * 
 * This server facilitates WebRTC connections between WebDHT peers by:
 * - Registering peers with their DHT node IDs
 * - Relaying signaling data between peers
 * - Tracking peer connections and disconnections
 * 
 * Usage: node signaling-server.js
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create Express app and HTTP server
const app = express();
const server = createServer(app);

// Initialize Socket.io with CORS settings
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static files from the example directory
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, '..')));

// Map to store connected peers (DHT nodeId -> socket.id)
const peers = new Map();

// Function to log with timestamp
function log(message) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] ${message}`);
}

// Handle socket connections
io.on('connection', (socket) => {
  log(`Client connected: ${socket.id}`);
  
  // Register the peer with its DHT nodeId
  socket.on('register', (nodeId) => {
    log(`Peer ${socket.id} registered with DHT nodeId: ${nodeId}`);
    peers.set(nodeId, socket.id);
    socket.nodeId = nodeId;
    
    // Let everyone know about the new peer
    socket.broadcast.emit('peer-joined', nodeId);
    
    // Send list of existing peers to the new peer
    const existingPeers = [];
    peers.forEach((_, peerId) => {
      if (peerId !== nodeId) existingPeers.push(peerId);
    });
    
    log(`Sending list of ${existingPeers.length} peers to ${nodeId}`);
    socket.emit('peers-list', existingPeers);
  });
  
  // Handle WebRTC signaling - this is the critical part for peer connections
  socket.on('signal', (data) => {
    if (!socket.nodeId) {
      log('Warning: Received signal from unregistered peer');
      return;
    }
    
    // CRITICAL FIX: Handle both client-side formats
    // Some clients send {to, data}, others send {targetNodeId, signal}
    let targetNodeId = data.to || data.targetNodeId;
    let signalData = data.data || data.signal;
    
    if (!targetNodeId || !signalData) {
      log(`Invalid signal format from ${socket.nodeId}: ${JSON.stringify(data)}`);
      return;
    }
    
    const signalType = signalData.type || 'candidate';
    log(`SIGNAL: ${socket.nodeId.substring(0, 8)} sending ${signalType} to ${targetNodeId.substring(0, 8)}`);
    
    const targetSocketId = peers.get(targetNodeId);
    if (targetSocketId) {
      log(`Relaying signal from ${socket.nodeId.substring(0, 8)} to ${targetNodeId.substring(0, 8)}`);
      try {
        // Use consistent format for all clients
        io.to(targetSocketId).emit('signal', {
          from: socket.nodeId,
          data: signalData
        });
        log(`Signal relayed successfully to socket ${targetSocketId}`);
      } catch (err) {
        log(`ERROR relaying signal: ${err.message}`);
      }
    } else {
      log(`Target peer ${targetNodeId} not found for signaling - check socket connections`);
      log(`Current peers: ${Array.from(peers.keys()).map(id => id.substring(0, 8)).join(', ')}`);
    }
  });
  
  // Handle explicit connection requests
  socket.on('connect-to-peer', (targetNodeId) => {
    if (!socket.nodeId) {
      log('Warning: Connection request from unregistered peer');
      return;
    }
    
    log(`${socket.nodeId} requested connection to ${targetNodeId}`);
    
    const targetSocketId = peers.get(targetNodeId);
    
    if (targetSocketId) {
      // CRITICAL FIX: Only one side should be the initiator
      // Use deterministic approach - compare node IDs to determine who initiates
      // This ensures consistent behavior and prevents both sides trying to be initiator
      const sourceNodeId = socket.nodeId;
      const isSourceInitiator = sourceNodeId < targetNodeId;
      
      log(`Connection direction: ${sourceNodeId.substring(0, 8)} to ${targetNodeId.substring(0, 8)}, initiator=${isSourceInitiator ? 'source' : 'target'}`);
      
      // Tell the source peer to connect to target (with appropriate initiator flag)
      socket.emit('initiate-connection', {
        peerId: targetNodeId,
        initiator: isSourceInitiator
      });
      
      // Tell the target peer to connect to source (with opposite initiator flag)
      io.to(targetSocketId).emit('initiate-connection', {
        peerId: sourceNodeId,
        initiator: !isSourceInitiator
      });
    } else {
      log(`Target peer ${targetNodeId} not found`);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    if (socket.nodeId) {
      log(`Peer ${socket.id} (DHT ${socket.nodeId}) disconnected`);
      peers.delete(socket.nodeId);
      io.emit('peer-left', socket.nodeId);
    }
  });
});

// Serve the signaling client example
app.get('/signaling-example', (req, res) => {
  res.sendFile(path.join(__dirname, 'signaling-client.html'));
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  log(`WebDHT Signaling Server running on port ${PORT}`);
  log(`Open http://localhost:${PORT}/signaling-example to try the signaling client`);
});

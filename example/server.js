/**
 * HTTPS-enabled signaling server for WebDHT
 * Required for SHA1 generation and secure development
 */

import express from "express";
import { WebSocketServer } from "ws";
import https from "https";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// ES modules setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Express app
const app = express();
const PORT = process.env.PORT || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Enable JSON parsing for API endpoints
app.use(express.json());

// Serve static files
app.use("/", express.static(path.join(__dirname)));
app.use("/src", express.static(path.join(__dirname, "..", "src")));
app.use("/transports", express.static(path.join(__dirname, "..", "transports")));

// Try to load SSL certificates
let httpsServer = null;
let httpsWss = null;

try {
    const privateKey = fs.readFileSync(path.join(__dirname, 'key.pem'), 'utf8');
    const certificate = fs.readFileSync(path.join(__dirname, 'cert.pem'), 'utf8');
    
    const credentials = { key: privateKey, cert: certificate };
    
    // Create HTTPS server
    httpsServer = https.createServer(credentials, app);
    
    // Create WebSocket server for HTTPS
    httpsWss = new WebSocketServer({ server: httpsServer });
    
    console.log('✅ SSL certificates loaded successfully');
} catch (error) {
    console.warn('⚠️  SSL certificates not found or invalid:', error.message);
    console.warn('   Run this command to generate certificates:');
    console.warn('   openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/C=US/ST=CA/L=San Francisco/O=Dev/OU=Dev/CN=localhost"');
}

// Create HTTP server (fallback)
const httpServer = http.createServer(app);
const httpWss = new WebSocketServer({ server: httpServer });

// Simple peer tracking
const peers = new Map(); // id -> websocket

// Tracking statistics
const peerStats = new Map(); // id -> {
  // byteCount, signalCount, dhtSignalCount, serverSignalCount,
  // connections: { target -> { type: 'dht'|'server', ... } }

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

// WebSocket message handler (shared between HTTP and HTTPS)
function handleWebSocketConnection(ws, req) {
  console.log(`📞 New WebSocket connection from ${req.socket.remoteAddress}`);
  let peerId = null;

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Handle registration
      if (data.type === "register" && data.peerId) {
        peerId = data.peerId;
        peers.set(peerId, ws);
        
        // Initialize stats for this peer
        if (!peerStats.has(peerId)) {
          peerStats.set(peerId, {
            byteCount: 0,
            signalCount: 0,
            dhtSignalCount: 0,
            serverSignalCount: 0,
            connections: new Map() // target -> { byteCount, signalCount, dhtSignalCount, serverSignalCount }
          });
        }
        
        console.log(`Registered: ${peerId}`);
        console.log(`Active peers: ${peers.size}`);

        // Find up to 3 closest peers by XOR distance
        const otherIds = Array.from(peers.keys()).filter(id => id !== peerId);
        const closest = otherIds
          .map(id => ({ id, distance: calculateXORDistance(peerId, id) }))
          .sort((a, b) => (a.distance < b.distance ? -1 : 1))
          .slice(0, 3)
          .map(p => p.id);

        // Track bytes sent
        const responseData = {
          type: "registered",
          peerId: peerId,
          peers: closest,
        };
        const responseStr = JSON.stringify(responseData);
        const bytesSent = Buffer.byteLength(responseStr);
        
        // Update stats
        const stats = peerStats.get(peerId);
        stats.byteCount += bytesSent;
        
        ws.send(responseStr);

        // Notify those closest peers of the newcomer
        closest.forEach(id => {
          const peerWs = peers.get(id);
          if (peerWs?.readyState === 1) {
            // Track bytes sent
            const notificationData = {
              type: "new_peer",
              peerId: peerId,
            };
            const notificationStr = JSON.stringify(notificationData);
            const bytesSent = Buffer.byteLength(notificationStr);
            
            // Update stats for the existing peer
            const existingStats = peerStats.get(id);
            if (existingStats) {
              existingStats.byteCount += bytesSent;
            }
            
            peerWs.send(notificationStr);
            console.log(`Notified ${id.substring(0,8)} of new peer ${peerId.substring(0,8)}`);
          }
        });

        // Log all current peers
        console.log("Current peers:", Array.from(peers.keys()));
      }

      // Handle DHT signal reports
      if (data.type === "dht_signal_report" && data.source && data.target) {
        const sourceId = data.source;
        const targetId = data.target;
        
        console.log(`DHT Signal Report: ${sourceId.substring(0, 8)}... -> ${targetId.substring(0, 8)}...`);
        console.log(`Full message: ${JSON.stringify(data)}`);
        
        // Update source peer stats
        const sourceStats = peerStats.get(sourceId);
        if (sourceStats) {
          // Increment DHT signal count
          sourceStats.dhtSignalCount = (sourceStats.dhtSignalCount || 0) + 1;
          sourceStats.signalCount++; // Also increment total signal count
          
          // Update per-connection stats
          if (!sourceStats.connections.has(targetId)) {
            sourceStats.connections.set(targetId, {
              byteCount: 0,
              signalCount: 0,
              dhtSignalCount: 0,
              serverSignalCount: 0
            });
          }
          const connectionStats = sourceStats.connections.get(targetId);
          connectionStats.dhtSignalCount++;
          connectionStats.signalCount++;
          connectionStats.type = 'dht'; // Track connection type
        }
      }
      
      // Handle server signal reports
      else if (data.type === "server_signal_report" && data.source && data.target) {
        const sourceId = data.source;
        const targetId = data.target;
        
        console.log(`Server Signal Report: ${sourceId.substring(0, 8)}... -> ${targetId.substring(0, 8)}...`);
        
        // Update source peer stats
        const sourceStats = peerStats.get(sourceId);
        if (sourceStats) {
          // Increment server signal count
          sourceStats.serverSignalCount = (sourceStats.serverSignalCount || 0) + 1;
          sourceStats.signalCount++; // Also increment total signal count
          
          // Update per-connection stats
          if (!sourceStats.connections.has(targetId)) {
            sourceStats.connections.set(targetId, {
              byteCount: 0,
              signalCount: 0,
              dhtSignalCount: 0,
              serverSignalCount: 0
            });
          }
          const connectionStats = sourceStats.connections.get(targetId);
          connectionStats.serverSignalCount++;
          connectionStats.signalCount++;
          connectionStats.type = 'server'; // Track connection type
        }
      }
      
      // Handle signaling
      else if (data.type === "signal" && data.target && data.signal) {
        const targetId = data.target;
        const targetWs = peers.get(targetId);

        console.log(`Signal: ${peerId} -> ${targetId}`);
        
        // Track signal count for this peer connection
        if (peerId) {
          const stats = peerStats.get(peerId);
          if (stats) {
            // Increment overall signal count
            stats.signalCount++;
            
            // Track per-connection stats
            if (!stats.connections.has(targetId)) {
              stats.connections.set(targetId, {
                byteCount: 0,
                signalCount: 0,
                dhtSignalCount: 0,
                serverSignalCount: 0
              });
            }
            const connectionStats = stats.connections.get(targetId);
            connectionStats.signalCount++;
            
            // All signals through the server are counted as server signals
            stats.serverSignalCount = (stats.serverSignalCount || 0) + 1;
            connectionStats.serverSignalCount = (connectionStats.serverSignalCount || 0) + 1;
            
            // Log signal counts for monitoring
            console.log(`Signal counts for ${peerId}: DHT=${stats.dhtSignalCount || 0}, Server=${stats.serverSignalCount || 0}, Ratio=${Math.round(((stats.dhtSignalCount || 0) / stats.signalCount) * 100)}%`);
          }
        }

        // Only forward if target is connected
        if (targetWs && targetWs.readyState === 1) {
          // WebSocket.OPEN
          const signalData = {
            type: "signal",
            peerId: peerId,
            signal: data.signal,
          };
          const signalStr = JSON.stringify(signalData);
          const bytesSent = Buffer.byteLength(signalStr);
          
          // Update byte count for target peer
          const targetStats = peerStats.get(targetId);
          if (targetStats) {
            targetStats.byteCount += bytesSent;
            
            // Track per-connection stats for target
            if (!targetStats.connections.has(peerId)) {
              targetStats.connections.set(peerId, {
                byteCount: 0,
                signalCount: 0,
                dhtSignalCount: 0,
                serverSignalCount: 0
              });
            }
            const connectionStats = targetStats.connections.get(peerId);
            connectionStats.byteCount += bytesSent;
          }
          
          targetWs.send(signalStr);
          console.log("Signal forwarded");
          
          // Broadcast signal event to all WebSocket servers
          const signalEvent = {
            type: 'signal_event',
            source: peerId,
            target: targetId,
            signalType: 'server'
          };
          
          const broadcastMessage = JSON.stringify(signalEvent);
          
          // Broadcast to HTTP WebSocket clients
          httpWss.clients.forEach(client => {
            if (client.readyState === 1) {
              client.send(broadcastMessage);
            }
          });
          
          // Broadcast to HTTPS WebSocket clients if available
          if (httpsWss) {
            httpsWss.clients.forEach(client => {
              if (client.readyState === 1) {
                client.send(broadcastMessage);
              }
            });
          }
        } else {
          console.log(`Peer ${targetId} not available`);
          
          const errorData = {
            type: "error",
            message: "Target peer not available",
          };
          const errorStr = JSON.stringify(errorData);
          const bytesSent = Buffer.byteLength(errorStr);
          
          // Update byte count for source peer
          if (peerId) {
            const stats = peerStats.get(peerId);
            if (stats) {
              stats.byteCount += bytesSent;
            }
          }
          
          ws.send(errorStr);
        }
      }
    } catch (err) {
      console.error("Message error:", err.message);
    }
  });

  // Handle disconnections
  // Broadcast network update when peers change
  const broadcastNetworkUpdate = () => {
    const nodes = Array.from(peers.keys()).map(id => ({ id }));
    const links = [];
    
    for (const [sourceId, stats] of peerStats.entries()) {
      for (const [targetId, conn] of stats.connections.entries()) {
        links.push({
          source: sourceId,
          target: targetId,
          type: conn.type
        });
      }
    }
    
    const update = {
      type: 'network_update',
      nodes,
      links
    };
    
    const broadcastMessage = JSON.stringify(update);
    
    // Broadcast to HTTP WebSocket clients
    httpWss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(broadcastMessage);
      }
    });
    
    // Broadcast to HTTPS WebSocket clients if available
    if (httpsWss) {
      httpsWss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(broadcastMessage);
        }
      });
    }
  };

  ws.on("close", () => {
    if (peerId) {
      console.log(`Disconnected: ${peerId}`);
      
      // Log final stats for this peer
      const stats = peerStats.get(peerId);
      if (stats) {
        console.log(`Stats for ${peerId}:`);
        console.log(`- Total bytes: ${stats.byteCount}`);
        console.log(`- Total signals: ${stats.signalCount}`);
        console.log(`- DHT signals: ${stats.dhtSignalCount || 0} (${Math.round((stats.dhtSignalCount || 0)/stats.signalCount*100 || 0)}%)`);
        console.log(`- Server signals: ${stats.serverSignalCount || 0} (${Math.round((stats.serverSignalCount || 0)/stats.signalCount*100 || 0)}%)`);
        
        // Log per-connection stats
        if (stats.connections.size > 0) {
          console.log(`- Connection details:`);
          for (const [targetId, connStats] of stats.connections.entries()) {
            console.log(`  - To ${targetId.substring(0, 8)}...: ${connStats.signalCount} signals (${connStats.dhtSignalCount || 0} DHT, ${connStats.serverSignalCount || 0} server), ${connStats.byteCount} bytes`);
          }
        }
      }
      
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
      
      // Keep the stats for later analysis but remove from active peers
      peers.delete(peerId);
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for peer ${peerId?.substring(0, 8) || 'unknown'}:`, err.message);
  });
}

// Set up WebSocket handlers for both HTTP and HTTPS
httpWss.on('connection', handleWebSocketConnection);
if (httpsWss) {
  httpsWss.on('connection', handleWebSocketConnection);
}

// Periodically log overall statistics
setInterval(() => {
  if (peers.size > 0) {
    console.log("\n--- Signaling Server Statistics ---");
    console.log(`Active peers: ${peers.size}`);
    
    let totalBytes = 0;
    let totalSignals = 0;
    let totalDhtSignals = 0;
    let totalServerSignals = 0;
    
    for (const [peerId, stats] of peerStats.entries()) {
      // Only show stats for active peers
      if (peers.has(peerId)) {
        totalBytes += stats.byteCount;
        totalSignals += stats.signalCount;
        totalDhtSignals += stats.dhtSignalCount || 0;
        totalServerSignals += stats.serverSignalCount || 0;
        
        console.log(`Peer ${peerId.substring(0, 8)}...:`);
        console.log(`- Bytes: ${stats.byteCount}`);
        console.log(`- Total Signals: ${stats.signalCount}`);
        console.log(`- DHT Signals: ${stats.dhtSignalCount || 0}`);
        console.log(`- Server Signals: ${stats.serverSignalCount || 0}`);
        console.log(`- Connections: ${stats.connections.size}`);
      }
    }
    
    console.log("\nTotals:");
    console.log(`- Total bytes transferred: ${totalBytes}`);
    console.log(`- Total signals: ${totalSignals}`);
    const dhtPercentage = totalSignals > 0 ? Math.round((totalDhtSignals/totalSignals)*100) : 0;
    const serverPercentage = totalSignals > 0 ? Math.round((totalServerSignals/totalSignals)*100) : 0;
    console.log(`- DHT signals: ${totalDhtSignals} (${dhtPercentage}%)`);
    console.log(`- Server signals: ${totalServerSignals} (${serverPercentage}%)`);
    console.log(`- Signal ratio: ${dhtPercentage}% DHT / ${serverPercentage}% server`);
    console.log(`- Average bytes per peer: ${Math.round(totalBytes / peers.size)}`);
    console.log(`- Average signals per peer: ${Math.round(totalSignals / peers.size)}`);
    console.log("--------------------------------\n");
  }
}, 60000); // Log stats every minute

// Route for serving the HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Route for serving the statistics page
app.get("/stats", (req, res) => {
  res.sendFile(path.join(__dirname, "stats.html"));
});

// Route for serving the chess game
app.get("/chess", (req, res) => {
  res.sendFile(path.join(__dirname, "game", "chess.html"));
});

// API endpoint to get signaling statistics
app.get("/api/stats", (req, res) => {
  const stats = {
    activePeers: peers.size,
    totalPeers: peerStats.size,
    peerStats: {},
    summary: {
      totalBytes: 0,
      totalSignals: 0,
      totalDhtSignals: 0,
      totalServerSignals: 0,
      averageBytes: 0,
      averageSignals: 0,
      averageDhtSignals: 0,
      averageServerSignals: 0
    }
  };
  
  // Collect stats for each peer
  for (const [peerId, peerStat] of peerStats.entries()) {
    const isActive = peers.has(peerId);
    
    // Add to summary totals
    if (isActive) {
      stats.summary.totalBytes += peerStat.byteCount;
      stats.summary.totalSignals += peerStat.signalCount;
      stats.summary.totalDhtSignals += peerStat.dhtSignalCount || 0;
      stats.summary.totalServerSignals += peerStat.serverSignalCount || 0;
    }
    
    // Add individual peer stats
    stats.peerStats[peerId] = {
      active: isActive,
      byteCount: peerStat.byteCount,
      signalCount: peerStat.signalCount,
      dhtSignalCount: peerStat.dhtSignalCount || 0,
      serverSignalCount: peerStat.serverSignalCount || 0,
      connections: {}
    };
    
    // Add connection details
    for (const [targetId, connStat] of peerStat.connections.entries()) {
      stats.peerStats[peerId].connections[targetId] = {
        byteCount: connStat.byteCount,
        signalCount: connStat.signalCount,
        dhtSignalCount: connStat.dhtSignalCount || 0,
        serverSignalCount: connStat.serverSignalCount || 0,
        active: peers.has(targetId)
      };
    }
  }
  
  // Calculate averages
  if (peers.size > 0) {
    stats.summary.averageBytes = Math.round(stats.summary.totalBytes / peers.size);
    stats.summary.averageSignals = Math.round(stats.summary.totalSignals / peers.size);
    stats.summary.averageDhtSignals = Math.round(stats.summary.totalDhtSignals / peers.size);
    stats.summary.averageServerSignals = Math.round(stats.summary.totalServerSignals / peers.size);
  }
  
  res.json(stats);
});

// Start servers
httpServer.listen(PORT, () => {
  console.log(`🌐 HTTP Server running on port ${PORT}`);
  console.log(`   Access via: http://localhost:${PORT}`);
  console.log(`   Or: http://192.168.50.68:${PORT}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`🔒 HTTPS Server running on port ${HTTPS_PORT}`);
    console.log(`   Access via: https://localhost:${HTTPS_PORT}`);
    console.log(`   Or: https://192.168.50.68:${HTTPS_PORT}`);
    console.log(`   ⚠️  You'll need to accept the self-signed certificate warning in your browser`);
  });
} else {
  console.log(`❌ HTTPS Server not started - SSL certificates missing`);
}

// Cleanup function
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down servers...');
  httpServer.close();
  if (httpsServer) {
    httpsServer.close();
  }
  process.exit(0);
});

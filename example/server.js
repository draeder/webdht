/**
 * Ultra-simple signaling server for WebDHT
 * No frills, maximum reliability
 */

import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

// ES modules setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Enable JSON parsing for API endpoints
app.use(express.json());

// Serve static files
app.use("/", express.static(path.join(__dirname)));
app.use("/src", express.static(path.join(__dirname, "..", "src")));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server for signaling
const wss = new WebSocketServer({ server });

// Simple peer tracking
const peers = new Map(); // id -> websocket

// Tracking statistics
const peerStats = new Map(); // id -> { byteCount, signalCount, dhtSignalCount, serverSignalCount, connections }

// Handle WebSocket connections
wss.on("connection", (ws) => {
  console.log("New connection");
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

        // Send current peer list
        const peerList = [];
        for (const id of peers.keys()) {
          if (id !== peerId) {
            peerList.push(id);
          }
        }

        // Track bytes sent
        const responseData = {
          type: "registered",
          peerId: peerId,
          peers: peerList,
        };
        const responseStr = JSON.stringify(responseData);
        const bytesSent = Buffer.byteLength(responseStr);
        
        // Update stats
        const stats = peerStats.get(peerId);
        stats.byteCount += bytesSent;
        
        ws.send(responseStr);

        // Notify all existing peers about the new peer
        for (const [existingPeerId, existingWs] of peers.entries()) {
          // Don't notify the new peer about itself
          if (existingPeerId !== peerId && existingWs.readyState === 1) {
            // WebSocket.OPEN
            console.log(`Notifying ${existingPeerId} about new peer ${peerId}`);
            
            // Track bytes sent
            const notificationData = {
              type: "new_peer",
              peerId: peerId,
            };
            const notificationStr = JSON.stringify(notificationData);
            const bytesSent = Buffer.byteLength(notificationStr);
            
            // Update stats for the existing peer
            const existingStats = peerStats.get(existingPeerId);
            if (existingStats) {
              existingStats.byteCount += bytesSent;
            }
            
            existingWs.send(notificationStr);
          }
        }

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
      
      // Keep the stats for later analysis but remove from active peers
      peers.delete(peerId);
    }
  });
});

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

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

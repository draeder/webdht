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
const PORT = process.env.PORT || 3000;

// Serve static files
app.use("/", express.static(path.join(__dirname)));
app.use("/src", express.static(path.join(__dirname, "..", "src")));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server for signaling
const wss = new WebSocketServer({ server });

// Simple peer tracking
const peers = new Map(); // id -> websocket

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
        console.log(`Registered: ${peerId}`);
        console.log(`Active peers: ${peers.size}`);

        // Send current peer list
        const peerList = [];
        for (const id of peers.keys()) {
          if (id !== peerId) {
            peerList.push(id);
          }
        }

        ws.send(
          JSON.stringify({
            type: "registered",
            peerId: peerId,
            peers: peerList,
          })
        );

        // Notify all existing peers about the new peer
        for (const [existingPeerId, existingWs] of peers.entries()) {
          // Don't notify the new peer about itself
          if (existingPeerId !== peerId && existingWs.readyState === 1) {
            // WebSocket.OPEN
            console.log(`Notifying ${existingPeerId} about new peer ${peerId}`);
            existingWs.send(
              JSON.stringify({
                type: "new_peer",
                peerId: peerId,
              })
            );
          }
        }

        // Log all current peers
        console.log("Current peers:", Array.from(peers.keys()));
      }

      // Handle signaling
      if (data.type === "signal" && data.target && data.signal) {
        const targetId = data.target;
        const targetWs = peers.get(targetId);

        console.log(`Signal: ${peerId} -> ${targetId}`);

        // Only forward if target is connected
        if (targetWs && targetWs.readyState === 1) {
          // WebSocket.OPEN
          targetWs.send(
            JSON.stringify({
              type: "signal",
              peerId: peerId,
              signal: data.signal,
            })
          );
          console.log("Signal forwarded");
        } else {
          console.log(`Peer ${targetId} not available`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Target peer not available",
            })
          );
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
      peers.delete(peerId);
    }
  });
});

// Route for serving the HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

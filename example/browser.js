/**
 * Browser example for WebDHT
 *
 * This example shows how to use WebDHT in a browser environment
 * with WebRTC peer connections through a signaling server.
 */

// Import WebDHT and the SHA1 functionality
import WebDHT from "/src/index.js";
import { generateRandomId } from "/src/sha1.js";

// WebSocket connection for signaling
let signalingSocket = null;

// Initialize the application
async function initApp() {
  try {
    console.log("Creating WebDHT instance...");
    // Create a WebDHT instance with signal batching and compression enabled
    const dht = new WebDHT({
      signalBatchInterval: 100, // Batch signals for 100ms
      signalCompression: true,  // Enable signal compression
      debug: true,              // Enable debug logging
      dhtSignalThreshold: 2,    // Reduced from default 3 to 2
      dhtRouteRefreshInterval: 15000, // Reduced from default 30s to 15s
      aggressiveDiscovery: true // Always enable aggressive discovery
    });

    // Set up the UI and event listeners once DHT is ready
    dht.on("ready", (nodeId) => {
      document.getElementById("peerId").textContent = nodeId;
      document.getElementById("status").textContent =
        "DHT node created with ID: " + nodeId;

      // Connect to signaling server
      connectToSignalingServer(dht, nodeId);

      // Set up the UI with the DHT instance
      setupUI(dht);
      console.log("Your peer ID is:", nodeId);
      console.log("Signal batching and compression enabled");
      
      // Set up periodic peer discovery through DHT
      setTimeout(() => {
        startDhtPeerDiscovery(dht);
      }, 5000); // Wait 5 seconds after connecting to signaling server
    });

    return dht;
  } catch (err) {
    console.error("Error initializing WebDHT:", err);
    document.getElementById("status").textContent = `Error: ${err.message}`;
  }
}

// Discover peers through the DHT and connect to them
async function startDhtPeerDiscovery(dht) {
  // Only start discovery if we have at least one peer (bootstrap node)
  // We need at least one peer to use as a bootstrap node for DHT discovery
  if (dht.peers.size < 1) {
    console.log("No peers connected yet, delaying DHT peer discovery");
    setTimeout(() => startDhtPeerDiscovery(dht), 5000);
    return;
  }
  
  console.log("Starting DHT peer discovery...");
  updateStatus("Discovering peers through DHT...");
  
  try {
    // First, discover peers through the DHT using our implementation
    const discoveredPeers = await dht.discoverPeers();
    console.log(`Discovered ${discoveredPeers.length} peers through DHT`);
    
    // Then, find nodes close to our own ID to get peers that should be in our routing table
    console.log("Finding nodes close to our own ID...");
    const closeSelfNodes = await dht.findNode(dht.nodeId);
    const closeSelfPeerIds = closeSelfNodes.map(node => typeof node.id === "string" ? node.id : node.id);
    console.log(`Found ${closeSelfPeerIds.length} nodes close to our own ID`);
    
    // Combine the results, removing duplicates
    const allPeerIds = [...discoveredPeers, ...closeSelfPeerIds];
    const uniquePeerIds = [...new Set(allPeerIds)].filter(id => id !== dht.nodeId);
    
    if (uniquePeerIds.length > 0) {
      updateStatus(`Discovered ${uniquePeerIds.length} unique peers through DHT`);
      
      // Connect to a subset of discovered peers to avoid connection storms
      // Prioritize peers we're not already connected to
      const peersToConnect = uniquePeerIds
        .filter(peerId => !dht.peers.has(peerId))
        .slice(0, 5); // Increased from 3 to 5 to establish more DHT connections
      
      console.log(`Attempting to connect to ${peersToConnect.length} new peers`);
      
      // Connect to discovered peers
      for (const peerId of peersToConnect) {
        // Skip if we're already connected to this peer
        if (dht.peers.has(peerId)) {
          console.log(`Already connected to peer ${peerId.substring(0, 8)}...`);
          continue;
        }
        
        console.log(`Connecting to discovered peer: ${peerId.substring(0, 8)}...`);
        try {
          await dht.connect({ id: peerId });
          console.log(`Connected to discovered peer: ${peerId.substring(0, 8)}...`);
          
          // After connecting to a new peer, wait a bit before connecting to the next one
          // This helps prevent connection storms and gives time for DHT routing tables to update
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
          console.warn(`Failed to connect to discovered peer ${peerId.substring(0, 8)}...: ${err.message}`);
        }
      }
    } else {
      console.log("No new peers discovered through DHT");
    }
    
    // Announce our presence in the DHT by finding nodes close to our ID
    // This helps other peers discover us
    console.log("Announcing our presence in the DHT...");
    await dht.findNode(dht.nodeId);
  } catch (err) {
    console.error("Error during DHT peer discovery:", err);
  }
  
  // Schedule next discovery
  // Use a shorter interval initially to build up the network faster
  // Reduce intervals to increase peer discovery frequency
  // Reduce intervals to increase peer discovery frequency
  const nextInterval = dht.peers.size < 3 ? 10000 : 30000; // 10 seconds if we have few peers, otherwise 30 seconds
  setTimeout(() => startDhtPeerDiscovery(dht), nextInterval);
}

// Helper function to update status with optional error styling
function updateStatus(message, isError = false) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  statusEl.textContent = message;

  if (isError) {
    statusEl.style.color = "red";
  } else {
    statusEl.style.color = ""; // Reset to default
  }

  console.log(isError ? "ERROR: " + message : "Status: " + message);
}

// Connect to the signaling server
function connectToSignalingServer(dht, nodeId) {
  console.log("Connecting to signaling server...");

  // Get the WebSocket URL from the current page URL
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;

  // Close any existing connection
  if (signalingSocket && signalingSocket.readyState !== WebSocket.CLOSED) {
    signalingSocket.close();
  }

  // Connect to the WebSocket signaling server
  signalingSocket = new WebSocket(`ws://${window.location.host}`);

  // Keep track of connected peers for demo
  const connectedPeers = new Set();

  // Track ongoing connection attempts
  const pendingConnections = new Map();

  // Setup signaling events
  signalingSocket.onopen = () => {
    console.log("Connected to signaling server");
    updateStatus("Connected to signaling server");

    // Register this peer with the signaling server
    const peerId = dht.nodeId;
    console.log(`Registering as peer: ${peerId}`);
    signalingSocket.send(
      JSON.stringify({
        type: "register",
        peerId: peerId,
      })
    );
  };

  signalingSocket.onerror = (error) => {
    console.error("WebSocket error:", error);
    updateStatus("Signaling connection error", true);
  };

  signalingSocket.onclose = () => {
    console.log("Disconnected from signaling server");
    updateStatus("Disconnected from signaling server", true);
  };

  // Function to update the available peer list in UI
  function updatePeerList(peerIds) {
    const peerListEl = document.getElementById("availablePeers");
    if (!peerListEl) return;

    // Clear the current list
    peerListEl.innerHTML = "";

    if (!peerIds || peerIds.length === 0) {
      const nopeersEl = document.createElement("li");
      nopeersEl.textContent = "No other peers available";
      peerListEl.appendChild(nopeersEl);
      return;
    }

    // Add each peer to the list
    peerIds.forEach((peerId) => {
      const peerEl = document.createElement("li");

      // Create a clickable element for easy connection
      const peerLink = document.createElement("a");
      peerLink.href = "#";
      peerLink.textContent = `${peerId.substring(0, 12)}...`;
      peerLink.onclick = (e) => {
        e.preventDefault();
        // Fill the target peer input with this ID
        const targetInput =
          document.getElementById("targetPeerId") ||
          document.getElementById("peerInfo");
        if (targetInput) {
          targetInput.value = peerId;
        }
      };

      peerEl.appendChild(peerLink);
      peerListEl.appendChild(peerEl);
    });
  }

  // Handle incoming messages from the signaling server
  signalingSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("Received:", data.type, data);

      // Handle different message types
      switch (data.type) {
        case "registered":
          // Successfully registered with the server
          console.log(`Registered as peer: ${data.peerId}`);
          console.log("Available peers:", data.peers);

          // Store our peer ID in the UI for easy reference
          const peerIdElement = document.getElementById("peerId");
          if (peerIdElement) {
            peerIdElement.textContent = data.peerId;
          }

          // Populate the peer list in UI
          if (data.peers && data.peers.length > 0) {
            updateStatus(`Connected! ${data.peers.length} peers available`);
            updatePeerList(data.peers);
          } else {
            updateStatus("Connected! No other peers available yet.");
          }
          break;

        case "new_peer":
          // A new peer has joined the network
          if (data.peerId) {
            console.log(`New peer joined: ${data.peerId}`);

            // Get the current peer list element
            const peerListEl = document.getElementById("availablePeers");
            if (peerListEl) {
              // Check if this peer is already in our list
              let peerExists = false;
              for (const child of peerListEl.children) {
                if (
                  child.textContent &&
                  child.textContent.includes(data.peerId)
                ) {
                  peerExists = true;
                  break;
                }
              }

              // If this is a new peer, add it to the list
              if (!peerExists) {
                updateStatus(
                  `New peer discovered: ${data.peerId.substring(0, 8)}...`
                );

                // Create a new list item for this peer
                const peerEl = document.createElement("li");

                // Create a clickable element for easy connection
                const peerLink = document.createElement("a");
                peerLink.href = "#";
                peerLink.textContent = `${data.peerId.substring(0, 12)}...`;
                peerLink.onclick = (e) => {
                  e.preventDefault();
                  // Fill the target peer input with this ID
                  const targetInput = document.getElementById("peerInfo");
                  if (targetInput) {
                    targetInput.value = data.peerId;
                  }
                };

                peerEl.appendChild(peerLink);
                peerListEl.appendChild(peerEl);
                
                // Automatically connect to the new peer if we don't have any connections yet
                // or if we're the second peer (which means we should connect to the first peer)
                if (dht.peers.size === 0) {
                  // Use lexicographical comparison to determine who initiates the connection
                  // This ensures only one side tries to be the initiator
                  const shouldInitiate = dht.nodeId < data.peerId;
                  
                  if (shouldInitiate) {
                    console.log(`Automatically connecting to peer: ${data.peerId.substring(0, 8)}... (we are initiator)`);
                    updateStatus(`Connecting to: ${data.peerId.substring(0, 8)}...`);
                    
                    // Initiate connection
                    // Add improved ICE configuration for better connection reliability
                    initiateConnection(dht, data.peerId, true, {
                      reconnectTimer: 3000,
                      iceCompleteTimeout: 5000,
                      retries: 3
                    })
                      .then(peer => {
                        console.log(`Auto-connected to peer: ${data.peerId.substring(0, 8)}...`);
                      })
                      .catch(err => {
                        console.error(`Failed to auto-connect to peer: ${err.message}`);
                        updateStatus(`Connection failed: ${err.message}`, true);
                      });
                  } else {
                    console.log(`Waiting for peer ${data.peerId.substring(0, 8)}... to initiate connection to us`);
                    updateStatus(`Waiting for connection from: ${data.peerId.substring(0, 8)}...`);
                  }
                }
              }
            }
          }
          break;

        case "signal":
          // Received a WebRTC signal from another peer
          if (!data.peerId || !data.signal) {
            console.error("Invalid signal data received:", data);
            return;
          }
    
          console.log(
            `Signal from: ${data.peerId?.substring(0, 8)}...`,
            data.signal
          );
    
          // Mark this peer as attempting to connect if we haven't seen it
          if (
            !connectedPeers.has(data.peerId) &&
            !pendingConnections.has(data.peerId)
          ) {
            pendingConnections.set(data.peerId, Date.now());
            updateStatus(
              `Incoming connection from: ${data.peerId.substring(0, 8)}...`
            );
          }
    
          // Pass the signal to our DHT
          try {
            console.log(
              `Processing signal from: ${data.peerId.substring(0, 8)}...`
            );
            
            // Detect if this is a WebRTC signaling message
            const isWebRTCSignal = data.signal && (data.signal.type === 'offer' || data.signal.type === 'answer' || data.signal.candidate);
            
            // Implement the specific signaling flow:
            // If we're receiving a signal via server, we should check if we're a bootstrap peer
            const isBootstrapPeer = dht.peers.size >= 2;
            
            // If we're a bootstrap peer and this isn't WebRTC signaling, establish DHT routes
            if (isBootstrapPeer && !isWebRTCSignal) {
              console.log(`Bootstrap peer received signal from ${data.peerId.substring(0, 8)}..., will establish DHT routes`);
              
              // We'll let the DHT signal handler in dht.js handle the DHT routing
              // It will establish routes between this new peer and other existing peers
            }
            
            // This is a server-routed signal since it came through the signaling server
            // Report it as a server signal
            if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
              console.log("Reporting server signal to server:", dht.nodeId, "<-", data.peerId);
              signalingSocket.send(
                JSON.stringify({
                  type: "server_signal_report",
                  source: data.peerId,
                  target: dht.nodeId
                })
              );
            }
            
            dht.signal({
              id: data.peerId, // Convert to the format DHT.signal expects
              signal: data.signal,
            });
          } catch (signalError) {
            console.error("Error processing signal:", signalError);
            updateStatus(`Signal error: ${signalError.message}`, true);
          }
          break;

        case "error":
          // Server reported an error
          console.log("Server error:", data.message);
          updateStatus(`Error: ${data.message}`, true);
          break;

        default:
          console.log("Unknown message type:", data.type);
      }
    } catch (err) {
      console.error("Error processing message:", err);
      updateStatus("Error processing message from server", true);
    }
  };

  // Handle connection close
  signalingSocket.onclose = () => {
    console.log("Disconnected from signaling server");
    updateStatus("Disconnected from signaling server", true);
  };

  // Listen for signal events from the DHT and forward them
  dht.on("signal", async (data) => {
    if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN)
      return;

    // Data should contain both the peer ID and the signal data
    if (data && data.id && data.signal) {
      const targetPeerId = data.id;
      console.log("Sending signal to:", targetPeerId.substr(0, 8) + "...");
      
      // Check if this signal was already routed through the DHT
      if (data.viaDht) {
        console.log(`Signal from ${targetPeerId.substr(0, 8)}... was received via DHT`);
        
        // Report this as a DHT signal to the server for statistics
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          console.log("Reporting DHT signal to server:", dht.nodeId, "->", targetPeerId);
          signalingSocket.send(
            JSON.stringify({
              type: "dht_signal_report",
              source: dht.nodeId,
              target: targetPeerId
            })
          );
        }
        return; // No need to forward it again
      }
      
      // Detect WebRTC signaling messages
      const isWebRTCSignal = data.signal && (data.signal.type === 'offer' || data.signal.type === 'answer');
      const isICECandidate = data.signal && data.signal.candidate;
      
      // Implement the specific signaling flow:
      // New Peer < - > Signaling Server < - > 1st discovered Existing Partial Mesh peer (bootstrap peer) < - > DHT Signaling < - > Other Existing Peers
      
      // For WebRTC signaling, always use the server to ensure reliable connection establishment
      if (isWebRTCSignal || isICECandidate) {
        console.log(`Using server for WebRTC signal to ${targetPeerId.substr(0, 8)}...`);
        
        // Send the signal through our signaling server
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        
        // Report this as a server signal to the server for statistics
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "server_signal_report",
              source: dht.nodeId,
              target: targetPeerId
            })
          );
        }
        return;
      }
      
      // Check if we're a new peer with few connections
      // Increase the threshold from 1 to 2 to encourage more DHT signaling
      const isNewPeer = dht.peers.size <= 2;
      
      if (isNewPeer) {
        console.log(`New peer with ${dht.peers.size} connections using server to signal ${targetPeerId.substr(0, 8)}...`);
        
        // New peers always use the server to connect to their first bootstrap peer
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        
        // Report this as a server signal to the server for statistics
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "server_signal_report",
              source: dht.nodeId,
              target: targetPeerId
            })
          );
        }
        return;
      }
      
      // For established peers, try to use DHT routing
      let signalSent = false;
      
      try {
        // If the peer is directly connected, send the signal directly
        if (dht.peers.has(targetPeerId)) {
          console.log(`Peer ${targetPeerId.substr(0, 8)}... is directly connected, sending signal through DHT`);
          
          // Get the peer from our DHT
          const directPeer = dht.peers.get(targetPeerId);
          if (directPeer && directPeer.connected) {
            console.log(`Sending signal directly through DHT to peer ${targetPeerId.substr(0, 8)}...`);
            
            // Send the signal directly through the peer connection
            directPeer.send({
              type: "SIGNAL",
              sender: dht.nodeId,
              originalSender: dht.nodeId,
              signal: data.signal,
              target: targetPeerId,
              viaDht: true,
              signalPath: [dht.nodeId]
            });
            
            // Report this as a DHT signal to the server for statistics
            if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
              console.log("Reporting DHT signal to server:", dht.nodeId, "->", targetPeerId);
              signalingSocket.send(
                JSON.stringify({
                  type: "dht_signal_report",
                  source: dht.nodeId,
                  target: targetPeerId
                })
              );
            }
            
            signalSent = true;
          }
        } else {
          // Find a bootstrap peer to route through
          const connectedPeers = Array.from(dht.peers.entries())
            .filter(([peerId, peer]) => peer.connected);
            
          if (connectedPeers.length > 0) {
            // Use the first connected peer as the bootstrap peer
            const [bootstrapPeerId, bootstrapPeer] = connectedPeers[0];
            
            console.log(`Routing signal to ${targetPeerId.substr(0, 8)}... via bootstrap peer ${bootstrapPeerId.substr(0, 8)}...`);
            
            // Send the signal through the bootstrap peer
            bootstrapPeer.send({
              type: "SIGNAL",
              sender: dht.nodeId,
              originalSender: dht.nodeId,
              signal: data.signal,
              target: targetPeerId,
              ttl: 3,
              viaDht: true,
              signalPath: [dht.nodeId]
            });
            
            // Report this as a DHT signal to the server for statistics
            if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
              console.log("Reporting DHT signal to server:", dht.nodeId, "->", targetPeerId);
              signalingSocket.send(
                JSON.stringify({
                  type: "dht_signal_report",
                  source: dht.nodeId,
                  target: targetPeerId
                })
              );
            }
            
            signalSent = true;
          }
        }
      } catch (err) {
        console.warn("Error routing through DHT:", err.message);
      }
      
      // Fall back to server only if DHT routing failed
      if (!signalSent) {
        console.log(`Falling back to server for signal to ${targetPeerId.substr(0, 8)}...`);
        
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        
        // Report this as a server signal to the server for statistics
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "server_signal_report",
              source: dht.nodeId,
              target: targetPeerId
            })
          );
        }
      }
    }
  });
}

// Store original emit function to restore later if needed
let originalDhtEmit = null;

// Initiate a connection to a peer
async function initiateConnection(dht, peerId, forceInitiator = false, additionalOptions = {}) {
  if (!peerId) {
    console.error("No peer ID provided");
    return;
  }

  // Use lexicographical comparison to determine who initiates the connection
  // This ensures only one side tries to be the initiator
  const shouldInitiate = forceInitiator || dht.nodeId < peerId;
  
  console.log(`Initiating connection to peer: ${peerId} (${shouldInitiate ? "we are" : "we are not"} the initiator)`);

  // Override the DHT's emit method ONLY ONCE to handle signaling
  if (!originalDhtEmit) {
    console.log("Setting up DHT signal handler (once)");
    originalDhtEmit = dht.emit;

    dht.emit = function (event, data) {
      if (event === "signal" && data && data.signal && data.peerId) {
        console.log(`Forwarding signal to: ${data.peerId.substring(0, 8)}...`);

        // Forward the signal via our signaling server
        if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "signal",
              target: data.peerId,
              signal: data.signal,
            })
          );
          return true; // Signal handled
        } else {
          console.error("Cannot send signal: WebSocket not connected");
        }
      }

      // For non-signal events, use default behavior
      if (originalDhtEmit) {
        return originalDhtEmit.call(dht, event, data);
      }
      return false;
    };
  }

  try {
    // Connect to the peer through the DHT
    // Note: DHT.connect expects an object with an 'id' property, not just a string
    console.log(`Connecting to DHT peer: ${peerId}`);
    
    // Add improved ICE configuration for better connection reliability
    const peer = await dht.connect({
      id: peerId,
      initiator: shouldInitiate,
      // Add improved ICE servers
      simplePeerOptions: {
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun3.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:19302" },
            { urls: "stun:global.stun.twilio.com:3478" },
            // Add free TURN servers for better NAT traversal
            {
              urls: "turn:openrelay.metered.ca:80",
              username: "openrelayproject",
              credential: "openrelayproject"
            },
            {
              urls: "turn:openrelay.metered.ca:443",
              username: "openrelayproject",
              credential: "openrelayproject"
            },
            {
              urls: "turn:openrelay.metered.ca:443?transport=tcp",
              username: "openrelayproject",
              credential: "openrelayproject"
            }
          ],
          iceCandidatePoolSize: 10,
          iceTransportPolicy: "all"
        },
        trickle: false, // Enable trickle ICE for better connection success
        sdpTransform: (sdp) => {
          // Add aggressive ICE restart and connection timeout settings
          return sdp.replace(/a=ice-options:trickle\r\n/g,
                            "a=ice-options:trickle renomination\r\n")
                   .replace(/a=setup:actpass\r\n/g,
                            "a=setup:actpass\r\na=connection-timeout:10\r\n");
        }
      },
      ...additionalOptions
    });

    // Set up event handlers for this peer connection
    peer.on("connect", () => {
      console.log(`Connected to peer: ${peerId}`);
      document.getElementById(
        "status"
      ).textContent = `Connected to: ${peerId.substring(0, 8)}...`;
    });

    peer.on("data", (data) => {
      const message = data.toString();
      console.log(`Received data from ${peerId.substring(0, 8)}...:`, message);

      // Add to messages list if it exists
      const messagesList = document.getElementById("messagesList");
      if (messagesList) {
        // Add formatted message to the list
        const formattedMessage = formatMessage(peerId, message, false);
        messagesList.appendChild(formattedMessage);

        // Scroll to the bottom of the messages list
        messagesList.scrollTop = messagesList.scrollHeight;
      }
    });

    peer.on("error", (err) => {
      console.error(`Peer connection error: ${err.message}`);
      document.getElementById(
        "status"
      ).textContent = `Connection error: ${err.message}`;
    });

    return peer;
  } catch (err) {
    console.error("Failed to connect:", err);
    document.getElementById(
      "status"
    ).textContent = `Connection failed: ${err.message}`;
    throw err;
  }
}

// Set up the UI and event handlers
function setupUI(dht) {
  // DOM Elements
  const statusEl = document.getElementById("status");
  const peerIdEl = document.getElementById("peerId");
  const connectForm = document.getElementById("connectForm");
  const peerInfoEl = document.getElementById("peerInfo");
  const storeForm = document.getElementById("storeForm");
  const retrieveForm = document.getElementById("retrieveForm");
  const resultEl = document.getElementById("result");
  const peersEl = document.getElementById("peers");

  // Set up connected peers tracking
  const connectedPeers = new Set();

  // Handle signals from DHT that need to be sent to peers
  dht.on("signal", (data) => {
    if (data && data.peerId && data.signal) {
      console.log(
        `Signal from DHT for peer: ${data.peerId.substring(0, 8)}...`
      );

      // Send signal through signaling server
      if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: data.peerId,
            signal: data.signal,
          })
        );
      } else {
        console.error("Cannot send signal: WebSocket not connected");
        statusEl.textContent = "Signaling error: WebSocket disconnected";
      }
    }
  });

  // Handle peer connections
  dht.on("peer:connect", (peerId) => {
    console.log(`Connected to peer: ${peerId.substring(0, 8)}...`);
    statusEl.textContent =
      "Connected to peer: " + peerId.substring(0, 8) + "...";
    connectedPeers.add(peerId);
    updatePeersList();

    // Send a test message to confirm connection works
    const peer = dht.peers.get(peerId);
    if (peer) {
      try {
        peer.send("Hello! Connection established!");
      } catch (err) {
        console.error("Error sending test message:", err);
      }
    }
  });

  // Handle peer disconnections
  dht.on("peer:disconnect", (peerId) => {
    console.log(`Disconnected from peer: ${peerId.substring(0, 8)}...`);
    statusEl.textContent =
      "Disconnected from peer: " + peerId.substring(0, 8) + "...";
    connectedPeers.delete(peerId);
    updatePeersList();
  });

  // Handle peer errors
  dht.on("peer:error", ({ peer, error }) => {
    console.error(`Peer error: ${peer.substring(0, 8)}...`, error);
    statusEl.textContent =
      "Error with peer: " + peer.substring(0, 8) + "... - " + error;
  });

  // Connect to a peer using ID
  connectForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const peerIdInput = peerInfoEl.value.trim();
      if (!peerIdInput) {
        statusEl.textContent = "Please enter a valid peer ID";
        return;
      }

      // Use lexicographical comparison to determine who initiates the connection
      const shouldInitiate = dht.nodeId < peerIdInput;
      console.log(`${shouldInitiate ? "We are" : "We are not"} the initiator for this connection`);
      
      // Just call initiateConnection - we'll handle all the signaling there
      statusEl.textContent = `Connecting to: ${peerIdInput.substring(0, 8)}...`;
      const peer = await initiateConnection(dht, peerIdInput, shouldInitiate, {
        reconnectTimer: 3000,
        iceCompleteTimeout: 5000,
        retries: 3
      });

      if (peer) {
        statusEl.textContent = `Connected to: ${peerIdInput.substring(
          0,
          8
        )}...`;
      }
    } catch (err) {
      console.error("Connection error:", err);
      statusEl.textContent = `Connection error: ${err.message}`;
    }
  });

  // Store a value
  storeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const key = document.getElementById("storeKey").value;
    const value = document.getElementById("storeValue").value;

    if (!key || !value) {
      resultEl.textContent = "Key and value are required";
      return;
    }

    statusEl.textContent = "Storing value...";

    try {
      const success = await dht.put(key, value);
      resultEl.textContent = success
        ? "Value stored successfully"
        : "Failed to store value";
      statusEl.textContent = success
        ? "Value stored successfully for key: " + key
        : "Failed to store value for key: " + key;
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
      statusEl.textContent = "Error: " + err.message;
    }
  });

  // Retrieve a value
  retrieveForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const key = document.getElementById("retrieveKey").value;

    if (!key) {
      resultEl.textContent = "Key is required";
      return;
    }

    statusEl.textContent = "Retrieving value...";

    try {
      const value = await dht.get(key);
      resultEl.textContent =
        value !== null ? "Retrieved value: " + value : "Value not found";
      statusEl.textContent =
        value !== null
          ? "Retrieved value for key: " + key
          : "Value not found for key: " + key;
    } catch (err) {
      resultEl.textContent = "Error: " + err.message;
      statusEl.textContent = "Error: " + err.message;
    }
  });

  // Update the list of connected peers
  function updatePeersList() {
    peersEl.innerHTML = "";

    if (connectedPeers.size === 0) {
      peersEl.textContent = "No connected peers";

      // Clear the select dropdown for sending messages
      const sendPeerIdEl = document.getElementById("sendPeerId");
      if (sendPeerIdEl) {
        sendPeerIdEl.innerHTML = '<option value="">Select a peer</option>';
      }
      return;
    }

    // Update the list of connected peers
    for (const peerId of connectedPeers) {
      const peerEl = document.createElement("div");
      peerEl.textContent = peerId.substring(0, 16) + "...";

      // Add a small disconnect button
      const disconnectBtn = document.createElement("button");
      disconnectBtn.textContent = "Disconnect";
      disconnectBtn.className = "button";
      disconnectBtn.style.marginLeft = "10px";
      disconnectBtn.style.padding = "3px 6px";
      disconnectBtn.style.fontSize = "0.8em";
      disconnectBtn.onclick = () => {
        dht.disconnect(peerId);
      };

      peerEl.appendChild(disconnectBtn);
      peersEl.appendChild(peerEl);
    }

    // Update the select dropdown for sending messages
    const sendPeerIdEl = document.getElementById("sendPeerId");
    if (sendPeerIdEl) {
      sendPeerIdEl.innerHTML = '<option value="">Select a peer</option>';
      for (const peerId of connectedPeers) {
        const option = document.createElement("option");
        option.value = peerId;
        option.textContent = peerId.substring(0, 12) + "...";
        sendPeerIdEl.appendChild(option);
      }
    }
  }

  // Set up the send message button
  const sendButton = document.getElementById("sendButton");
  const messageInput = document.getElementById("messageInput");
  const sendPeerIdEl = document.getElementById("sendPeerId");
  const messagesList = document.getElementById("messagesList");

  if (sendButton && messageInput && sendPeerIdEl && messagesList) {
    sendButton.addEventListener("click", () => {
      const selectedPeerId = sendPeerIdEl.value;
      const message = messageInput.value.trim();

      if (!selectedPeerId || !message) {
        updateStatus("Please select a peer and enter a message", true);
        return;
      }

      try {
        // Get the peer from our DHT
        const peer = dht.peers.get(selectedPeerId);
        if (!peer) {
          updateStatus(
            `Peer ${selectedPeerId.substring(0, 8)}... not found`,
            true
          );
          return;
        }

        // Send the message
        peer.send(message);
        console.log(`Sent to ${selectedPeerId.substring(0, 8)}...:`, message);

        // Add to the messages list with formatting
        const formattedMessage = formatMessage(selectedPeerId, message, true);
        messagesList.appendChild(formattedMessage);

        // Scroll to the bottom of the messages list
        messagesList.scrollTop = messagesList.scrollHeight;

        // Clear the message input
        messageInput.value = "";
      } catch (err) {
        console.error("Failed to send message:", err);
        updateStatus(`Failed to send: ${err.message}`, true);
      }
    });
  }
}

// Show SHA1 performance demonstration
async function demonstrateSHA1() {
  const resultEl = document.getElementById("result");
  resultEl.innerHTML = "";

  try {
    // Generate multiple peer IDs to demonstrate SHA1 performance
    const peers = [];
    const startTime = performance.now();

    // Generate 5 peer IDs in sequence
    for (let i = 0; i < 5; i++) {
      const id = await generateRandomId();
      peers.push(id);

      // Display each generated ID with better formatting
      const peerEl = document.createElement("div");
      peerEl.style.padding = "6px 0";
      peerEl.style.borderBottom = "1px solid #eaecef";
      peerEl.style.fontFamily = "monospace";
      peerEl.innerHTML = `<strong>Peer ${i + 1}:</strong> ${id.substring(
        0,
        8
      )}...${id.substring(
        id.length - 8
      )} <button class="button button-secondary" style="font-size: 12px; padding: 2px 6px; margin-left: 10px;" onclick="navigator.clipboard.writeText('${id}')">Copy</button>`;
      resultEl.appendChild(peerEl);
    }

    const endTime = performance.now();
    const timeEl = document.createElement("div");
    timeEl.style.marginTop = "10px";
    timeEl.textContent = `Generated 5 SHA1 peer IDs in ${(
      endTime - startTime
    ).toFixed(2)}ms`;
    resultEl.appendChild(timeEl);
  } catch (err) {
    resultEl.textContent = `Error in SHA1 demo: ${err.message}`;
  }
}

// Handle the tabbed interface
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const tabContents = document.querySelectorAll(".tab-content");

  if (!tabs.length) return; // No tabs found

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      // Remove active class from all tabs and contents
      tabs.forEach((t) => t.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));

      // Add active class to clicked tab and its content
      tab.classList.add("active");
      const tabId = tab.getAttribute("data-tab");
      document.getElementById(`${tabId}-content`).classList.add("active");
    });
  });
}

// Format messages for better display
function formatMessage(peerId, message, isOutgoing = false) {
  const listItem = document.createElement("li");
  listItem.className = isOutgoing ? "outgoing" : "incoming";

  if (isOutgoing) {
    listItem.textContent = `${message}`;
  } else {
    listItem.textContent = `${message}`;
  }

  return listItem;
}

// Start initialization when the document is loaded
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("status").textContent = "Initializing WebDHT...";
  let dht = initApp();

  // Set up the tabbed interface
  setupTabs();

  // If demo button exists, add event listener
  const demoButton = document.getElementById("demoButton");
  if (demoButton) {
    demoButton.addEventListener("click", demonstrateSHA1);
  }
});

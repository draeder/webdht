/**
 * Consolidated API for WebDHT operations, peer discovery, and signaling.
 * Handles both browser and Node.js environments.
 */

import WebDHT from "./index.js"; // Assuming index.js is the main export
import Logger from './logger.js';

// Keep track of connected peers for demo/logging
const connectedPeers = new Set();
// Track ongoing connection attempts
const pendingConnections = new Map();

let signalingSocket = null;
let dhtInstance = null;
let uiAdapter = {
  updateStatus: (message, isError = false) => _logDebug?.(isError ? `ERROR: ${message}` : `Status: ${message}`),
  updatePeerList: (peerIds) => _logDebug?.("Available peers:", peerIds),
  addMessage: (peerId, message, isOutgoing) => _logDebug?.(`Message ${isOutgoing ? 'to' : 'from'} ${peerId.substring(0,8)}: ${message}`),
  getWebSocket: (url) => new WebSocket(url), // Browser default
  updateConnectedPeers: (peers) => {
    if (!peers || !peers.length) return;
    _logDebug(`Connected peers (${peers.length}): ${peers.map(p => p.substring(0, 8) + '...').join(', ')}`);
  }
};


// Global logger instance
let logger = null;
// Global debug logging function
let _logDebug = function() {}; // Default no-op implementation

/**
 * Initializes the API manager with a DHT instance and UI adapter.
 * @param {WebDHT} dht - The WebDHT instance.
 * @param {object} adapter - An adapter for UI/environment interactions.
 */
export function initializeApi(dht, adapter, debug = false) {    
  /**
   * Helper for conditional debug logging
   * @private
   */
  // Initialize logger
  logger = new Logger("API");
  
  // Create debug logging function
  _logDebug = (...args) => {
    if (debug) {
      // Don't try to use this.nodeIdHex since we're in a module context
      const prefix = dht && dht.nodeId ? dht.nodeId.substring(0, 4) : "API";
      // Format args to include the node ID prefix at the beginning
      const formattedArgs = [`[${prefix}]`, ...args];
      // Use the logger instance
      logger.debug(...formattedArgs);
    }
  }

  dhtInstance = dht;
  if (adapter) {
    uiAdapter = { ...uiAdapter, ...adapter };
  }

  // Listen for signal events from the DHT and forward them
  dhtInstance.on("signal", async (data) => {
    // We should check if the socket is open without creating a new WebSocket with empty URL
    const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
    if (!signalingSocket || signalingSocket.readyState !== WS_OPEN) return;

    // Data should contain both the peer ID and the signal data
    if (data && data.id && data.signal) {
      const targetPeerId = data.id;
      _logDebug?.("API: Sending signal to:", targetPeerId.substr(0, 8) + "...");

      // Check if this signal was already routed through the DHT
      if (data.viaDht) {
        _logDebug?.(`API: Signal from ${targetPeerId.substr(0, 8)}... was received via DHT`);
        // Report this as a DHT signal to the server for statistics
        const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
        if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
          _logDebug?.("API: Reporting DHT signal to server:", dhtInstance.nodeId, "->", targetPeerId);
          signalingSocket.send(
            JSON.stringify({
              type: "dht_signal_report",
              source: dhtInstance.nodeId,
              target: targetPeerId
            })
          );
        }
        return; // No need to forward it again
      }

      // Check if trickle ICE is disabled in the DHT instance
      const isTrickleDisabled = dhtInstance.simplePeerOptions &&
                               dhtInstance.simplePeerOptions.trickle === false;
      
      // Detect WebRTC signaling messages
      const isWebRTCSignal = data.signal && (data.signal.type === 'offer' || data.signal.type === 'answer');
      const isICECandidate = data.signal && data.signal.candidate;

      // When trickle is disabled, offers/answers should already include candidates
      // So we don't expect many ICE candidate messages
      if (isTrickleDisabled && isICECandidate) {
        _logDebug?.(`API: Unexpected ICE candidate with trickle disabled for ${targetPeerId.substr(0, 8)}...`);
      }
      
      // For WebRTC signaling, always use the server to ensure reliable connection establishment
      if (isWebRTCSignal) {
        _logDebug?.(`API: Using server for WebRTC offer/answer signal to ${targetPeerId.substr(0, 8)}...`);
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        // Report this as a server signal
        const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
        if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "server_signal_report",
              source: dhtInstance.nodeId,
              target: targetPeerId
            })
          );
        }
        return;
      }
      
      // For ICE candidates when trickle is enabled
      if (isICECandidate) {
        // When trickle is disabled, we should still allow the server to handle candidates
        // but log the unexpected behavior
        if (isTrickleDisabled) {
          _logDebug?.(`API: Using server for unexpected ICE candidate with trickle disabled for ${targetPeerId.substr(0, 8)}...`);
        } else {
          _logDebug?.(`API: Using server for ICE candidate signal to ${targetPeerId.substr(0, 8)}...`);
        }
        
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        // Report this as a server signal
        const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
        if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "server_signal_report",
              source: dhtInstance.nodeId,
              target: targetPeerId
            })
          );
        }
        return;
      }

      // Check connection count for DHT signaling decision (logic adapted from browser.js)
      const isNewPeer = dhtInstance.peers.size <= 2;
      if (isNewPeer) {
        _logDebug?.(`API: New peer with ${dhtInstance.peers.size} connections using server to signal ${targetPeerId.substr(0, 8)}...`);
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        // Report as server signal
        const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
        if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
          signalingSocket.send(
            JSON.stringify({
              type: "server_signal_report",
              source: dhtInstance.nodeId,
              target: targetPeerId
            })
          );
        }
        return;
      }

      // For established peers, try DHT routing (simplified for now, needs full logic)
      let signalSent = false;
      try {
        if (dhtInstance.peers.has(targetPeerId)) {
          const directPeer = dhtInstance.peers.get(targetPeerId);
          if (directPeer && directPeer.connected) {
             _logDebug?.(`API: Sending signal directly via DHT to peer ${targetPeerId.substr(0, 8)}...`);
             directPeer.send({
               type: "SIGNAL",
               sender: dhtInstance.nodeId,
               originalSender: dhtInstance.nodeId,
               signal: data.signal,
               target: targetPeerId,
               viaDht: true,
               signalPath: [dhtInstance.nodeId]
             });
             signalSent = true;
             // Report DHT signal
             const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
             if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
                signalingSocket.send(JSON.stringify({ type: "dht_signal_report", source: dhtInstance.nodeId, target: targetPeerId }));
             }
          }
        } else {
           // Attempt routing via another peer (simplified - picks first connected)
           const connectedPeers = Array.from(dhtInstance.peers.entries()).filter(([_, peer]) => peer.connected);
           if (connectedPeers.length > 0) {
              const [bootstrapPeerId, bootstrapPeer] = connectedPeers[0];
              _logDebug?.(`API: Routing signal to ${targetPeerId.substr(0, 8)}... via bootstrap peer ${bootstrapPeerId.substr(0, 8)}...`);
              bootstrapPeer.send({
                 type: "SIGNAL",
                 sender: dhtInstance.nodeId,
                 originalSender: dhtInstance.nodeId,
                 signal: data.signal,
                 target: targetPeerId,
                 ttl: 3,
                 viaDht: true,
                 signalPath: [dhtInstance.nodeId]
              });
              signalSent = true;
              // Report DHT signal
              const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
              if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
                 signalingSocket.send(JSON.stringify({ type: "dht_signal_report", source: dhtInstance.nodeId, target: targetPeerId }));
              }
           }
        }
      } catch (err) {
        _logDebug?.("API: Error routing through DHT:", err.message);
      }

      // Fallback to server
      if (!signalSent) {
        _logDebug?.(`API: Falling back to server for signal to ${targetPeerId.substr(0, 8)}...`);
        signalingSocket.send(
          JSON.stringify({
            type: "signal",
            target: targetPeerId,
            signal: data.signal,
          })
        );
        // Report server signal
        const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
        if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
          signalingSocket.send(JSON.stringify({ type: "server_signal_report", source: dhtInstance.nodeId, target: targetPeerId }));
        }
      }
    }
  });

  // Listen for peer connection events with peer: prefix
  dhtInstance.on("peer:connect", (peerId) => {
    _logDebug?.(`API: Connected to peer: ${peerId.substring(0, 8)}...`);
    connectedPeers.add(peerId);
    pendingConnections.delete(peerId);
    uiAdapter.updateStatus(`Connected to: ${peerId.substring(0, 8)}...`);
    
    // Sync the connectedPeers set with dhtInstance.peers for consistency
    // This ensures our local tracking matches the DHT's source of truth
    connectedPeers.clear();
    dhtInstance.peers.forEach((peer, id) => {
      if (peer.connected) {
        connectedPeers.add(id);
      }
    });
    
    _logDebug?.(`Updating connected peers list with ${connectedPeers.size} peers`);
    if (uiAdapter.updateConnectedPeers) {
      uiAdapter.updateConnectedPeers(Array.from(connectedPeers));
    }
    // The signaling server message 'registered' or 'new_peer' should update the list
    // Or we can call uiAdapter.updatePeerList([...connectedPeers]); if needed

    // Get the peer object from the DHT instance
    const peer = dhtInstance.peers.get(peerId);
    if (!peer) {
      _logDebug?.(`API: Could not find peer object for ${peerId.substring(0, 8)}...`);
      return;
    }

    // Listen for data from this specific peer
    peer.on("data", (data) => {
      try {
        const message = JSON.parse(data.toString()); // Assuming JSON messages
        _logDebug?.(`API: Data from ${peerId.substring(0, 8)}...:`, message);
        if (message.type === 'MESSAGE') {
           uiAdapter.addMessage(peerId, message.payload, false); // false = incoming
        }
        // Handle other message types if necessary
      } catch (err) {
        _logDebug?.(`API: Error processing data from ${peerId.substring(0, 8)}...:`, err);
        // Handle non-JSON data if needed
        uiAdapter.addMessage(peerId, `Received non-JSON data: ${data.toString()}`, false);
      }
    });

    peer.on("close", () => {
      _logDebug?.(`API: Peer connection closed: ${peerId.substring(0, 8)}...`);
      connectedPeers.delete(peerId);
      pendingConnections.delete(peerId); // Remove if it was pending and closed
      uiAdapter.updateStatus(`Peer disconnected: ${peerId.substring(0, 8)}...`);
      
      // Sync the connectedPeers set with dhtInstance.peers for consistency
      connectedPeers.clear();
      dhtInstance.peers.forEach((peer, id) => {
        if (peer.connected) {
          connectedPeers.add(id);
        }
      });
      
      _logDebug?.(`Peer closed - updating connected peers list to ${connectedPeers.size}`);
      if (uiAdapter.updateConnectedPeers) {
        uiAdapter.updateConnectedPeers(Array.from(connectedPeers));
      }
    });

     peer.on("error", (err) => {
       _logDebug?.(`API: Peer connection error (${peerId.substring(0, 8)}...):`, err);
       connectedPeers.delete(peerId);
       pendingConnections.delete(peerId);
       uiAdapter.updateStatus(`Peer error (${peerId.substring(0, 8)}...): ${err.message}`, true);
       
       // Sync the connectedPeers set with dhtInstance.peers for consistency
       connectedPeers.clear();
       dhtInstance.peers.forEach((peer, id) => {
         if (peer.connected) {
           connectedPeers.add(id);
         }
       });
       
       _logDebug?.(`Peer error - updating connected peers list to ${connectedPeers.size}`);
       if (uiAdapter.updateConnectedPeers) {
         uiAdapter.updateConnectedPeers(Array.from(connectedPeers));
       }
     });
  });

  // Listen for general disconnection events with peer: prefix
  dhtInstance.on("peer:disconnect", (peerId, reason) => {
    _logDebug?.(`API: Disconnected from peer: ${peerId.substring(0, 8)}... Reason: ${reason || 'unknown'}`);
    connectedPeers.delete(peerId);
    pendingConnections.delete(peerId);
    uiAdapter.updateStatus(`Peer disconnected: ${peerId.substring(0, 8)}...`);
    
    // Sync the connectedPeers set with dhtInstance.peers for consistency
    connectedPeers.clear();
    dhtInstance.peers.forEach((peer, id) => {
      if (peer.connected) {
        connectedPeers.add(id);
      }
    });
    
    _logDebug?.(`Peer disconnected - updating connected peers list to ${connectedPeers.size}`);
    if (uiAdapter.updateConnectedPeers) {
      uiAdapter.updateConnectedPeers(Array.from(connectedPeers));
    }
  });

  // Add handlers for other peer events
  dhtInstance.on("peer:error", (data) => {
    const peerId = data.peer;
    const errorMsg = data.error;
    _logDebug?.(`API: Peer error event for ${peerId.substring(0, 8)}...: ${errorMsg}`);
    uiAdapter.updateStatus(`Peer error (${peerId.substring(0, 8)}...): ${errorMsg}`, true);
  });

  dhtInstance.on("peer:limit_reached", (peerId) => {
    _logDebug?.(`API: Peer limit reached for ${peerId.substring(0, 8)}...`);
    uiAdapter.updateStatus(`Connection to ${peerId.substring(0, 8)}... failed: Peer limit reached`, true);
  });
}

/**
 * Connects to the signaling server.
 * @param {string} url - The WebSocket URL of the signaling server.
 * @param {object} options - Optional parameters including reconnection attempts.
 */
export function connectSignaling(url, options = {}) {
  if (!dhtInstance) {
    _logDebug?.("API Error: DHT not initialized. Call initializeApi first.");
    return;
  }
  
  const nodeId = dhtInstance.nodeId;
  const reconnectAttempts = options.reconnectAttempts || 0;

  _logDebug?.("API: Connecting to signaling server...", url);

  // Close any existing connection
  const WS_CLOSED = uiAdapter.getWebSocket ? 3 : WebSocket.CLOSED; // 3 is the standard CLOSED state
  if (signalingSocket && signalingSocket.readyState !== WS_CLOSED) {
    signalingSocket.close();
  }

  // Use the adapter to create the WebSocket connection
  signalingSocket = uiAdapter.getWebSocket(url);

  signalingSocket.onopen = () => {
    _logDebug?.("API: Connected to signaling server");
    uiAdapter.updateStatus("Connected to signaling server");

    // Dispatch connection event
    document.dispatchEvent(new CustomEvent('signaling:connected', {
      detail: { url, reconnectAttempts }
    }));

    // Register this peer
    _logDebug?.(`API: Registering as peer: ${nodeId}`);
    signalingSocket.send(
      JSON.stringify({
        type: "register",
        peerId: nodeId,
      })
    );
  };

  signalingSocket.onerror = (error) => {
    _logDebug?.("API: WebSocket error:", error);
    uiAdapter.updateStatus("Signaling connection error", true);
    
    // Dispatch error event
    document.dispatchEvent(new CustomEvent('signaling:error', {
      detail: { url, error, reconnectAttempts }
    }));
  };

  signalingSocket.onclose = (event) => {
    _logDebug?.("API: Disconnected from signaling server");
    uiAdapter.updateStatus("Disconnected from signaling server", true);
    
    // Dispatch disconnection event with clean/unclean status and attempts
    document.dispatchEvent(new CustomEvent('signaling:disconnected', {
      detail: {
        url,
        wasClean: event.wasClean,
        attempts: reconnectAttempts + 1
      }
    }));
    
    signalingSocket = null; // Clear socket reference
  };

  signalingSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      _logDebug?.("API: Received:", data.type, data);

      switch (data.type) {
        case "registered":
          _logDebug?.(`API: Registered as peer: ${data.peerId}`);
          _logDebug?.("API: Available peers:", data.peers);
          if (data.peers && data.peers.length > 0) {
            uiAdapter.updateStatus(`Connected! ${data.peers.length} peers available`);
            uiAdapter.updatePeerList(data.peers);
            
            // Dispatch event for auto-connection
            if (data.peers.length > 0) {
              document.dispatchEvent(new CustomEvent('api:registered', {
                detail: { peers: data.peers }
              }));
            }
          } else {
            uiAdapter.updateStatus("Connected! No other peers available yet.");
            uiAdapter.updatePeerList([]);
          }
          break;

        case "new_peer":
          if (data.peerId) {
            _logDebug?.(`API: New peer joined: ${data.peerId}`);
            uiAdapter.updateStatus(`New peer discovered: ${data.peerId.substring(0, 8)}...`);
            
            if (data.peers) {
              uiAdapter.updatePeerList(data.peers);
            } else {
              _logDebug?.("API: 'new_peer' message did not contain full peer list. UI might be incomplete.");
            }
            
            // Dispatch event for auto-connection
            document.dispatchEvent(new CustomEvent('api:new_peer', {
              detail: { peerId: data.peerId }
            }));
          }
          break;

        case "peer_left":
           if (data.peerId) {
             _logDebug?.(`API: Peer left: ${data.peerId}`);
             uiAdapter.updateStatus(`Peer left: ${data.peerId.substring(0, 8)}...`);
             
             if (data.peers) {
               uiAdapter.updatePeerList(data.peers);
             } else {
               _logDebug?.("API: 'peer_left' message did not contain full peer list. UI might be incomplete.");
             }
           }
           break;

        case "signal":
          if (!data.peerId || !data.signal) {
            _logDebug?.("API: Invalid signal data received:", data);
            return;
          }
          _logDebug?.(`API: Signal from: ${data.peerId?.substring(0, 8)}...`, data.signal);

          if (!connectedPeers.has(data.peerId) && !pendingConnections.has(data.peerId)) {
            pendingConnections.set(data.peerId, Date.now());
            uiAdapter.updateStatus(`Incoming connection from: ${data.peerId.substring(0, 8)}...`);
          }

          try {
            _logDebug?.(`API: Processing signal from: ${data.peerId.substring(0, 8)}...`);
            // Report server signal
            const WS_OPEN = uiAdapter.getWebSocket ? 1 : WebSocket.OPEN; // 1 is the standard OPEN state
            if (signalingSocket && signalingSocket.readyState === WS_OPEN) {
               signalingSocket.send(JSON.stringify({ type: "server_signal_report", source: data.peerId, target: dhtInstance.nodeId }));
            }

            // Pass signal to DHT instance
            dhtInstance.signal({
              id: data.peerId,
              signal: data.signal,
              viaDht: false // Signal came via server
            });
          } catch (signalError) {
            _logDebug("API: Error processing signal:", signalError);
            uiAdapter.updateStatus(`Signal error: ${signalError.message}`, true);
          }
          break;

        case "error":
          _logDebug("API: Server error:", data.message);
          uiAdapter.updateStatus(`Error: ${data.message}`, true);
          break;

        default:
          _logDebug("API: Unknown message type:", data.type);
      }
    } catch (err) {
      _logDebug("API: Error processing message:", err);
      uiAdapter.updateStatus("Error processing message from server", true);
    }
  };
}

/**
 * Initiates a connection to a peer.
 * @param {string} peerId - The ID of the peer to connect to.
 * @param {boolean} [forceInitiator=false] - Force this node to be the initiator.
 * @param {object} [additionalOptions={}] - Additional options for the connection.
 * @returns {Promise<Peer>} A promise that resolves with the Peer instance upon connection.
 */
export async function connectPeer(peerId, forceInitiator = false, additionalOptions = {}) {
  if (!dhtInstance) {
    throw new Error("API Error: DHT not initialized.");
  }
  if (!peerId) {
    throw new Error("API Error: No peer ID provided for connection.");
  }

  // Use lexicographical comparison to determine who initiates
  const shouldInitiate = forceInitiator || dhtInstance.nodeId < peerId;
  _logDebug(`API: Initiating connection to peer: ${peerId} (${shouldInitiate ? "we are" : "we are not"} the initiator)`);
  uiAdapter.updateStatus(`Connecting to: ${peerId.substring(0, 8)}...`);

  try {
    // Connect via DHT instance
    const peer = await dhtInstance.connect({
      id: peerId,
      initiator: shouldInitiate,
      // Pass simplePeerOptions from dhtInstance if available
      simplePeerOptions: dhtInstance.simplePeerOptions,
      ...additionalOptions
    });

    // Setup event handlers for this peer
    setupPeerEvents(peer, peerId);

    return peer;
  } catch (err) {
    _logDebug?.("API: Failed to connect:", err);
    uiAdapter.updateStatus(`😀 Connection failed: ${err.message}`, true);
    throw err;
  }
}

/**
 * Attaches standard event listeners to a peer connection.
 * @param {Peer} peer - The simple-peer instance.
 * @param {string} peerId - The ID of the peer.
 */
function setupPeerEvents(peer, peerId) {
  if (peer._eventsAttached) return; // Prevent duplicate listeners
  peer._eventsAttached = true;

  peer.on("connect", () => {
    if (typeof _logDebug === 'function') {
      _logDebug(`API: Connected to ${peerId}`);
    }
    uiAdapter.updateStatus(`Connected to: ${peerId.substring(0, 8)}...`);
    connectedPeers.add(peerId);
    pendingConnections.delete(peerId);
    // Update UI with connected peers list
    if (typeof _logDebug === 'function') {
      _logDebug(`Updating connected peers list with ${connectedPeers.size} peers`);
    }
    if (uiAdapter.updateConnectedPeers) {
      uiAdapter.updateConnectedPeers(Array.from(connectedPeers));
    } else {
      uiAdapter.updatePeerList([...connectedPeers]); // Fallback to updatePeerList
    }
    // Ensure both initiator and receiver see the status update
    if (typeof peer.initiator !== "undefined" && !peer.initiator) {
      uiAdapter.updateStatus(`Connected to: ${dhtInstance.nodeId.substring(0, 8)}...`);
    }
    // Optionally send a hello message
    // peer.send(`Hello from ${dhtInstance.nodeId}`);
  });

  peer.on("error", (err) => {
    if (typeof _logDebug === 'function') {
      _logDebug(`API: Peer ${peerId} error:`, err);
    }
    uiAdapter.updateStatus(`Peer error (${peerId.substring(0, 8)}...): ${err.message}`, true);
    // Consider removing peer from connectedPeers here if error is fatal
  });

  peer.on("close", () => {
    if (typeof _logDebug === 'function') {
      _logDebug(`API: Peer ${peerId} connection closed.`);
    }
    uiAdapter.updateStatus(`Disconnected from: ${peerId.substring(0, 8)}...`);
    connectedPeers.delete(peerId);
    pendingConnections.delete(peerId);
    // Update UI with connected peers list
    _logDebug(`Updating connected peers list with ${connectedPeers.size} peers`);
    _logDebug(`Peer disconnected - updating connected peers list to ${connectedPeers.size}`);
    if (uiAdapter.updateConnectedPeers) {
      uiAdapter.updateConnectedPeers(Array.from(connectedPeers));
    } else {
      uiAdapter.updatePeerList([...connectedPeers]); // Fallback to updatePeerList
    }
    peer._eventsAttached = false; // Allow re-attaching if reconnected
  });

  // No duplicate event handlers needed here as they're already defined in initializeApi

  // Listen for general disconnection events (might be redundant with peer.on('close'))
  // Removed duplicate disconnect event listener that was causing multiple status updates
  // This event is already handled by the peer.on('close') handler above
  // and globally in the initializeApi function
}

/**
 * Stores a key-value pair in the DHT.
 * @param {string} key - The key to store.
 * @param {string} value - The value to store.
 * @returns {Promise<boolean>} A promise that resolves with true if successful, false otherwise.
 */
export async function putValue(key, value) {
  if (!dhtInstance) {
    throw new Error("API Error: DHT not initialized.");
  }
  if (!key || !value) {
    throw new Error("API Error: Key and value are required for putValue.");
  }

  uiAdapter.updateStatus(`Storing value for key: ${key}...`);
  try {
    const success = await dhtInstance.put(key, value);
    const message = success ? "Value stored successfully" : "Failed to store value";
    uiAdapter.updateStatus(`${message} for key: ${key}`);
    return success;
  } catch (err) {
    _logDebug("API: Failed to store value:", err);
    uiAdapter.updateStatus(`Error storing value: ${err.message}`, true);
    throw err;
  }
}

/**
 * Retrieves a value from the DHT.
 * @param {string} key - The key to retrieve.
 * @returns {Promise<string|null>} A promise that resolves with the value or null if not found.
 */
export async function getValue(key) {
  if (!dhtInstance) {
    throw new Error("API Error: DHT not initialized.");
  }
  if (!key) {
    throw new Error("API Error: Key is required for getValue.");
  }

  uiAdapter.updateStatus(`Retrieving value for key: ${key}...`);
  try {
    const value = await dhtInstance.get(key);
    const message = value !== null ? `Retrieved value for key: ${key}` : `Value not found for key: ${key}`;
    uiAdapter.updateStatus(message);
    // Optionally notify UI adapter with the retrieved value
    // uiAdapter.displayResult(value !== null ? `Retrieved: ${value}` : "Value not found");
    return value;
  } catch (err) {
    _logDebug("API: Failed to retrieve value:", err);
    uiAdapter.updateStatus(`Error retrieving value: ${err.message}`, true);
    throw err;
  }
}

/**
 * Starts periodic peer discovery and connection attempts via DHT.
 * @param {number} [initialDelay=5000] - Delay before the first discovery attempt.
 */
export function startDiscovery(initialDelay = 5000) {
  if (!dhtInstance) {
    _logDebug("API Error: DHT not initialized.");
    return;
  }

  setTimeout(() => {
    _runDiscoveryCycle();
  }, initialDelay);
}

async function _runDiscoveryCycle() {
  if (!dhtInstance) return; // Stop if DHT is not available

  // Only run discovery if we have bootstrap connection(s)
  if (dhtInstance.peers.size < 1) {
    _logDebug("API: No peers connected yet, delaying DHT peer discovery");
    setTimeout(_runDiscoveryCycle, 10000); // Check again in 10s
    return;
  }

  _logDebug("API: Starting DHT peer discovery cycle...");
  // Only show "Discovering peers" status if we have fewer than 3 connections
  if (dhtInstance.peers.size < 3) {
    uiAdapter.updateStatus("Discovering peers through DHT...");
  }

  try {
    // Discover peers using DHT's findNode and potentially other methods
    const discoveredPeers = await dhtInstance.discoverPeers(); // Assuming discoverPeers exists
    _logDebug(`API: Discovered ${discoveredPeers.length} peers via discoverPeers`);

    _logDebug("API: Finding nodes close to our own ID...");
    const closeSelfNodes = await dhtInstance.findNode(dhtInstance.nodeId);
    const closeSelfPeerIds = closeSelfNodes.map(node => typeof node.id === "string" ? node.id : node.id);
    _logDebug(`API: Found ${closeSelfPeerIds.length} nodes close to self`);

    // Combine, filter, and connect
    const allPeerIds = [...discoveredPeers, ...closeSelfPeerIds];
    const uniquePeerIds = [...new Set(allPeerIds)].filter(id => id !== dhtInstance.nodeId);
    
    // Filter out peers we're already connected to or connecting to
    const newPeerIds = uniquePeerIds.filter(peerId =>
      !dhtInstance.peers.has(peerId) && !pendingConnections.has(peerId)
    );

    // Only update status if we found new peers to connect to
    if (newPeerIds.length > 0) {
      uiAdapter.updateStatus(`Discovered ${newPeerIds.length} new unique peers through DHT`);
      const peersToConnect = newPeerIds.slice(0, 5); // Limit connection attempts per cycle

      _logDebug(`API: Attempting to connect to ${peersToConnect.length} new peers`);
      for (const peerId of peersToConnect) {
        if (dhtInstance.peers.has(peerId)) continue;
        _logDebug(`API: Connecting to discovered peer: ${peerId.substring(0, 8)}...`);
        try {
          await connectPeer(peerId); // Use the API's connect function
          // Wait briefly between connections
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
          _logDebug(`API: Failed to connect to discovered peer ${peerId.substring(0, 8)}...: ${err.message}`);
        }
      }
    } else {
      _logDebug("API: No new peers discovered in this cycle.");
      // Don't update UI when no new peers are found to avoid spamming status messages
    }

    // Announce presence
    _logDebug("API: Announcing presence in the DHT...");
    await dhtInstance.findNode(dhtInstance.nodeId);

  } catch (err) {
    _logDebug("API: Error during DHT peer discovery cycle:", err);
    uiAdapter.updateStatus(`Discovery error: ${err.message}`, true);
  }

  // Schedule next cycle
  const nextInterval = dhtInstance.peers.size < 3 ? 15000 : 30000; // Adjust intervals as needed
  _logDebug(`API: Scheduling next discovery cycle in ${nextInterval / 1000}s`);
  setTimeout(_runDiscoveryCycle, nextInterval);
}

/**
 * Connects to a specific peer manually.
 * @param {string} peerId - The ID of the peer to connect to.
 */
export async function connectToPeer(peerId) {
  if (!dhtInstance) {
    _logDebug("API Error: DHT not initialized.");
    uiAdapter.updateStatus("DHT not ready.", true);
    return;
  }
  if (!peerId || typeof peerId !== 'string') {
     _logDebug("API Error: Invalid Peer ID provided.");
     uiAdapter.updateStatus("Invalid Peer ID.", true);
     return;
  }
  if (dhtInstance.peers.has(peerId)) {
    _logDebug(`API: Already connected or connecting to ${peerId.substring(0, 8)}...`);
    uiAdapter.updateStatus(`Already connected/connecting to ${peerId.substring(0, 8)}...`);
    return;
  }

  _logDebug(`API: Attempting manual connection to peer: ${peerId.substring(0, 8)}...`);
  uiAdapter.updateStatus(`Connecting to: ${peerId.substring(0, 8)}...`);
  pendingConnections.set(peerId, Date.now());

  try {
    // Use the existing connectPeer function which handles initiator logic
    await connectPeer(peerId); 
    // Connection success is handled by the 'connect' event listener setup in initializeApi
  } catch (err) {
    if (_logDebug) _logDebug(`API: Failed to connect to peer ${peerId.substring(0, 8)}...:`, err);
    // uiAdapter.updateStatus(`Failed to connect to ${peerId.substring(0, 8)}: ${err.message}`, true);
    pendingConnections.delete(peerId);
  }
}

/**
 * Sends a message to a specific connected peer.
 * @param {string} peerId - The ID of the target peer.
 * @param {string} messageText - The message content.
 */
export function sendMessageToPeer(peerId, messageText) {
  if (!dhtInstance) {
    _logDebug("API Error: DHT not initialized.");
    return;
  }
  const peer = dhtInstance.peers.get(peerId);
  if (peer && peer.connected) {
    try {
      const message = JSON.stringify({ type: 'MESSAGE', payload: messageText });
      peer.send(message);
      _logDebug(`API: Sent message to ${peerId.substring(0, 8)}...: ${messageText}`);
      uiAdapter.addMessage(peerId, messageText, true); // true = outgoing
    } catch (err) {
      _logDebug(`API: Error sending message to ${peerId.substring(0, 8)}...:`, err);
      uiAdapter.updateStatus(`Error sending message: ${err.message}`, true);
    }
  } else {
    _logDebug(`API: Peer ${peerId.substring(0, 8)}... not connected or found.`);
    uiAdapter.updateStatus(`Cannot send message: Peer ${peerId.substring(0, 8)}... not connected.`, true);
  }
}

/**
 * Starts the periodic peer discovery process using the DHT.
 * Renamed from startDiscovery to avoid conflict and be more specific.
 */
let discoveryTimeout = null;
export function startDhtPeerDiscovery() {
  if (!dhtInstance) {
    _logDebug("API Error: DHT not initialized.");
    return;
  }

  // Clear any existing timeout
  if (discoveryTimeout) clearTimeout(discoveryTimeout);

  const performDiscovery = async () => {
    // Use the internal _runDiscoveryCycle logic
    await _runDiscoveryCycle(); 

    // Schedule next discovery
    const nextInterval = dhtInstance.peers.size < 3 ? 15000 : 30000; // 15s if few peers, else 30s
    _logDebug(`API: Scheduling next DHT discovery in ${nextInterval / 1000} seconds.`);
    discoveryTimeout = setTimeout(performDiscovery, nextInterval);
  };

  // Start the first cycle
  performDiscovery(); 
}

/**
 * Stops the periodic peer discovery process.
 */
export function stopDhtPeerDiscovery() {
  if (discoveryTimeout) {
    clearTimeout(discoveryTimeout);
    discoveryTimeout = null;
    _logDebug("API: Stopped DHT peer discovery.");
  }
}

// Add other functions here later
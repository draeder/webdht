/**
 * Consolidated API for WebDHT operations, peer discovery, signaling, and messaging.
 * Handles both browser and Node.js environments.
 */

import WebDHT from "./index.js"; // Assuming index.js is the main export

// Keep track of connected peers for demo/logging
const connectedPeers = new Set();
const pendingConnections = new Map();

let signalingSocket = null;
let dhtInstance = null;
let uiAdapter = {
  updateStatus: (message, isError = false) => _logDebug(isError ? `ERROR: ${message}` : `Status: ${message}`),
  updatePeerList: (peerIds) => _logDebug("Available peers:", peerIds),
  addMessage: (peerId, message, isOutgoing) => _logDebug(`Message ${isOutgoing ? 'to' : 'from'} ${peerId.substring(0,8)}: ${message}`),
  getWebSocket: (url) => new WebSocket(url) // Browser default
};

// Debug logger
function _logDebug(...args) {
  if (dhtInstance && dhtInstance.debug) {
    console.debug("[API]", ...args);
  }
}

/**
 * Initializes the API manager with a DHT instance and UI adapter.
 * @param {WebDHT} dht - The WebDHT instance.
 * @param {object} adapter - An adapter for UI/environment interactions.
 */
export function initializeApi(dht, adapter) {
  dhtInstance = dht;
  if (adapter) {
    uiAdapter = { ...uiAdapter, ...adapter };
  }

  // Forward every DHT-emitted signal to the signaling server
  dhtInstance.on("signal", ({ id, signal }) => {
    if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) return;
    _logDebug(dhtInstance, "Forwarding signal to server for peer:", id.substring(0,8));
    signalingSocket.send(JSON.stringify({
      type: "signal",
      target: id,
      signal: signal,
    }));
  });

  // Handle newly connected peers
  dhtInstance.on("peer:connect", (peerId) => {
    const peer = dhtInstance.peers.get(peerId);
    if (!peer) return;
    _logDebug(dhtInstance, `Connected to peer: ${peerId.substring(0,8)}`);
    connectedPeers.add(peerId);
    pendingConnections.delete(peerId);
    uiAdapter.updateStatus(`Connected to peer: ${peerId.substring(0,8)}`);
    uiAdapter.updateConnectedPeers?.(Array.from(connectedPeers));

    peer.on("data", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'MESSAGE') {
          uiAdapter.addMessage(peerId, msg.payload, false);
        } else {
          uiAdapter.addMessage(peerId, data.toString(), false);
        }
      } catch {
        uiAdapter.addMessage(peerId, data.toString(), false);
      }
    });

    peer.on("close", () => {
      _logDebug(dhtInstance, `Peer disconnected: ${peerId.substring(0,8)}`);
      connectedPeers.delete(peerId);
      pendingConnections.delete(peerId);
      uiAdapter.updateStatus(`Peer disconnected: ${peerId.substring(0,8)}`);
      uiAdapter.updateConnectedPeers?.(Array.from(connectedPeers));
    });

    peer.on("error", (err) => {
      _logDebug(dhtInstance, `Peer error (${peerId.substring(0,8)}):`, err);
      connectedPeers.delete(peerId);
      pendingConnections.delete(peerId);
      uiAdapter.updateStatus(`Peer error (${peerId.substring(0,8)}): ${err.message}`, true);
      uiAdapter.updateConnectedPeers?.(Array.from(connectedPeers));
    });
  });

  // Handle peer disconnect events
  dhtInstance.on("peer:disconnect", (peerId) => {
    connectedPeers.delete(peerId);
    pendingConnections.delete(peerId);
    uiAdapter.updateStatus(`Peer disconnected: ${peerId.substring(0,8)}`);
    uiAdapter.updateConnectedPeers?.(Array.from(connectedPeers));
  });
}

/**
 * Connects to the signaling server.
 * @param {string} url - The WebSocket URL of the signaling server.
 * @param {object} options - Optional parameters including reconnection attempts.
 */
export function connectSignaling(url, options = {}) {
  if (!dhtInstance) {
    _logDebug("API Error: DHT not initialized. Call initializeApi first.");
    return;
  }
  const reconnectAttempts = options.reconnectAttempts || 0;

  // Close any existing connection
  if (signalingSocket && signalingSocket.readyState !== WebSocket.CLOSED) {
    signalingSocket.close();
  }

  signalingSocket = uiAdapter.getWebSocket(url);

  signalingSocket.onopen = () => {
    _logDebug(dhtInstance, "Connected to signaling server");
    uiAdapter.updateStatus("Connected to signaling server");
    document.dispatchEvent(new CustomEvent('signaling:connected', {
      detail: { url, reconnectAttempts }
    }));
    signalingSocket.send(JSON.stringify({
      type: "register",
      peerId: dhtInstance.nodeId,
    }));
  };

  signalingSocket.onerror = (error) => {
    _logDebug("API: WebSocket error:", error);
    uiAdapter.updateStatus("Signaling connection error", true);
    document.dispatchEvent(new CustomEvent('signaling:error', {
      detail: { url, error, reconnectAttempts }
    }));
  };

  signalingSocket.onclose = (event) => {
    _logDebug(dhtInstance, "Disconnected from signaling server");
    uiAdapter.updateStatus("Disconnected from signaling server", true);
    document.dispatchEvent(new CustomEvent('signaling:disconnected', {
      detail: {
        url,
        wasClean: event.wasClean,
        attempts: reconnectAttempts + 1
      }
    }));
    signalingSocket = null;
  };

  signalingSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "registered":
          uiAdapter.updatePeerList(data.peers || []);
          document.dispatchEvent(new CustomEvent('api:registered', { detail: { peers: data.peers } }));
          break;
        case "new_peer":
          uiAdapter.updatePeerList(data.peers || []);
          document.dispatchEvent(new CustomEvent('api:new_peer', { detail: { peerId: data.peerId } }));
          break;
        case "peer_left":
          uiAdapter.updatePeerList(data.peers || []);
          break;
        case "signal":
          if (data.peerId && data.signal) {
            pendingConnections.set(data.peerId, Date.now());
            uiAdapter.updateStatus(`Incoming connection from: ${data.peerId.substring(0,8)}`);
            dhtInstance.signal({ id: data.peerId, signal: data.signal, viaDht: false });
          }
          break;
        case "error":
          uiAdapter.updateStatus(`Error: ${data.message}`, true);
          break;
      }
    } catch (err) {
      _logDebug("API: Error processing message from server", err);
    }
  };
}

/**
 * Initiates a connection to a peer.
 * @param {string} peerId - The ID of the peer to connect to.
 * @param {boolean} [forceInitiator=false] - Force this node to be the initiator.
 * @param {object} [options={}] - Additional options for the connection.
 * @returns {Promise<Peer>} A promise that resolves with the Peer instance.
 */
export async function connectPeer(peerId, forceInitiator = false, options = {}) {
  if (!dhtInstance) throw new Error("API Error: DHT not initialized.");
  if (!peerId) throw new Error("API Error: No peer ID provided.");

  const shouldInitiate = forceInitiator || dhtInstance.nodeId < peerId;
  uiAdapter.updateStatus(`Connecting to: ${peerId.substring(0,8)}`);

  try {
    const peer = await dhtInstance.connect({ id: peerId, initiator: shouldInitiate, ...options });
    return peer;
  } catch (err) {
    uiAdapter.updateStatus(`Connection failed: ${err.message}`, true);
    throw err;
  }
}

// Alias for CLI compatibility
export const connectToPeer = connectPeer;

/**
 * Sends a message to a connected peer.
 * @param {string} peerId - The ID of the peer.
 * @param {string} message - The message payload.
 */
export function sendMessageToPeer(peerId, message) {
  if (!dhtInstance) throw new Error("API Error: DHT not initialized.");
  const peer = dhtInstance.peers.get(peerId);
  if (!peer || !peer.connected) {
    throw new Error(`No active connection to peer ${peerId}`);
  }
  nodeAdapter.addMessage(peerId, message, true); // show outgoing
  const msgObj = { type: 'MESSAGE', payload: message };
  peer.send(JSON.stringify(msgObj));
}

/**
 * Stores a key-value pair in the DHT.
 * @param {string} key - The key to store.
 * @param {string} value - The value to store.
 * @returns {Promise<boolean>}
 */
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
  if (!key || value === undefined || value === null) {
    throw new Error("API Error: Key and value are required for putValue.");
  }

  uiAdapter.updateStatus(`Storing value for key: ${key}...`);
  try {
    const success = await dhtInstance.put(key, value);
    uiAdapter.updateStatus(
      success
        ? `Value stored successfully for key: ${key}`
        : `Failed to store value for key: ${key}`
    );
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
    uiAdapter.updateStatus(
      value !== null
        ? `Retrieved value for key: ${key}`
        : `Value not found for key: ${key}`
    );
    return value;
  } catch (err) {
    _logDebug("API: Failed to retrieve value:", err);
    uiAdapter.updateStatus(`Error retrieving value: ${err.message}`, true);
    throw err;
  }
}

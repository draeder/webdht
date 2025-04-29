/**
 * Browser example for WebDHT
 *
 * This example shows how to use WebDHT in a browser environment
 * with WebRTC peer connections through a signaling server and UI controls.
 */

// Import WebDHT and SHA1 functionality
import WebDHT from "/src/index.js";
import { generateRandomId } from "/src/sha1.js";
// Import consolidated API functions
import {
  initializeApi,
  connectSignaling,
  connectToPeer,
  sendMessageToPeer,
  putValue,
  getValue
} from "../src/api.js";

// Track connection attempts to prevent duplicates
const connectionAttempts = new Set();

// Cache for UI elements
const uiElements = {};
function cacheUIElements() {
  uiElements.peerId = document.getElementById("peerId");
  uiElements.status = document.getElementById("status");
  uiElements.signalingUrl = document.getElementById("signalingUrl");
  uiElements.connectSignalingBtn = document.getElementById("connectSignalingBtn");
  uiElements.peerList = document.getElementById("peerList");
  uiElements.connectPeerId = document.getElementById("connectPeerId");
  uiElements.connectPeerBtn = document.getElementById("connectPeerBtn");
  uiElements.messagePeerId = document.getElementById("messagePeerId");
  uiElements.messageInput = document.getElementById("messageInput");
  uiElements.sendMessageBtn = document.getElementById("sendMessageBtn");
  uiElements.chatMessages = document.getElementById("chatMessages");
  uiElements.putKey = document.getElementById("putKey");
  uiElements.putValue = document.getElementById("putValue");
  uiElements.putBtn = document.getElementById("putBtn");
  uiElements.getKey = document.getElementById("getKey");
  uiElements.getBtn = document.getElementById("getBtn");
  uiElements.getResult = document.getElementById("getResult");
  uiElements.peers = document.getElementById("peers");
  uiElements.connectionStatus = document.getElementById("connectionStatus");
}

// UI adapter for api.js
const browserUiAdapter = {
  updateStatus: (message, isError = false) => {
    if (uiElements.status) {
      uiElements.status.textContent = message;
      uiElements.status.style.color = isError ? "red" : "";
    }
    console.log(isError ? `ERROR: ${message}` : `Status: ${message}`);
  },
  updatePeerList: (peerIds) => {
    if (!uiElements.peerList) return;
    uiElements.peerList.innerHTML = "";
    const select = uiElements.messagePeerId;
    const prev = select.value;
    select.innerHTML = '<option value="">Select Peer</option>';
    peerIds.forEach(id => {
      const short = id.substring(0,8) + '...';
      const li = document.createElement('li');
      li.textContent = `${short} (${id})`;
      li.onclick = () => {
        uiElements.connectPeerId.value = id;
        uiElements.messagePeerId.value = id;
      };
      uiElements.peerList.appendChild(li);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = short;
      select.appendChild(opt);
    });
    if (peerIds.includes(prev)) select.value = prev;
  },
  addMessage: (peerId, message, isOutgoing) => {
    if (!uiElements.chatMessages) return;
    const prefix = isOutgoing ? `To ${peerId.substring(0,8)}:` : `From ${peerId.substring(0,8)}:`;
    const div = document.createElement('div');
    div.textContent = `${prefix} ${message}`;
    div.className = isOutgoing ? 'outgoing-message' : 'incoming-message';
    uiElements.chatMessages.appendChild(div);
    uiElements.chatMessages.scrollTop = uiElements.chatMessages.scrollHeight;
  },
  getWebSocket: url => new WebSocket(url),
  updateConnectedPeers: ids => {
    if (!uiElements.peers) return;
    uiElements.peers.innerHTML = '';
    if (ids.length === 0) {
      uiElements.peers.textContent = 'No connected peers';
      return;
    }
    const ul = document.createElement('ul');
    ids.forEach(id => {
      const li = document.createElement('li');
      li.textContent = `${id.substring(0,8)}...`;
      ul.appendChild(li);
    });
    uiElements.peers.appendChild(ul);
  },
  updateConnectionStatus: status => {
    if (!uiElements.connectionStatus) return;
    uiElements.connectionStatus.textContent = status;
    uiElements.connectionStatus.style.color = status.includes('Connected') ? 'green'
      : status.includes('Connecting') ? 'orange' : 'red';
  }
};

// Setup tab UI functionality
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const pane = document.getElementById(`${tab.dataset.tab}-content`);
      if (pane) pane.classList.add('active');
    });
  });
}

// Main init App
async function initApp() {
  cacheUIElements();
  setupTabs();
  setupUIEventListeners();

  try {
    console.log('Creating WebDHT instance...');
    const dht = new WebDHT({
      signalBatchInterval: 100,
      signalCompression: true,
      debug: true,
      dhtSignalThreshold: 2,
      dhtRouteRefreshInterval: 15000,
      aggressiveDiscovery: true,
      simplePeerOptions: { trickle: false }
    });

    initializeApi(dht, browserUiAdapter);

    // Hook signaling events
    document.addEventListener('signaling:connected', () => {
      browserUiAdapter.updateConnectionStatus('Connected to signaling server');
    });
    document.addEventListener('signaling:disconnected', () => {
      browserUiAdapter.updateConnectionStatus('Disconnected from signaling server');
    });
    document.addEventListener('signaling:error', () => {
      browserUiAdapter.updateConnectionStatus('Signaling connection error');
    });

    const defaultWs = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    uiElements.signalingUrl && (uiElements.signalingUrl.value = defaultWs);

    dht.on('ready', nodeId => {
      uiElements.peerId && (uiElements.peerId.textContent = nodeId);
      browserUiAdapter.updateStatus('DHT node ready: ' + nodeId);
      browserUiAdapter.updateConnectionStatus('Connecting to signaling server...');
      connectSignaling(defaultWs);
    });

    dht.on('error', err => {
      console.error('DHT Global Error:', err);
      browserUiAdapter.updateStatus(`DHT Error: ${err.message}`, true);
    });

    return dht;
  } catch (err) {
    console.error('Error initializing WebDHT:', err);
    browserUiAdapter.updateStatus(`Init Error: ${err.message}`, true);
  }
}

// Expose for auto-init
window.initApp = async () => {
  window.dhtInstance = await initApp();
  return window.dhtInstance;
};
document.addEventListener('DOMContentLoaded', window.initApp);

// UI Event Listeners
function setupUIEventListeners() {
  const on = (key, evt, fn) => uiElements[key]?.addEventListener(evt, fn);

  on('connectSignalingBtn','click',() => {
    const url = uiElements.signalingUrl.value;
    if (!url) return browserUiAdapter.updateStatus('Enter signaling URL', true);
    browserUiAdapter.updateConnectionStatus('Connecting to signaling server...');
    connectSignaling(url);
  });

  on('connectPeerBtn','click',() => {
    const id = uiElements.connectPeerId.value;
    if (!id) return browserUiAdapter.updateStatus('Enter peer ID', true);
    connectToPeer(id);
  });

  on('sendMessageBtn','click',() => {
    const id = uiElements.messagePeerId.value;
    const msg = uiElements.messageInput.value;
    if (!id || !msg) return browserUiAdapter.updateStatus('Select peer and enter message', true);
    sendMessageToPeer(id, msg);
    uiElements.messageInput.value = '';
  });

  on('putBtn','click', async e => {
    e.preventDefault();
    const key = uiElements.putKey.value;
    const val = uiElements.putValue.value;
    if (!key || !val) return browserUiAdapter.updateStatus('Enter key and value', true);
    try {
      await putValue(key,val);
      browserUiAdapter.updateStatus('Stored ' + key);
      uiElements.putKey.value = uiElements.putValue.value = '';
    } catch {};
  });

  on('getBtn','click', async e => {
    e.preventDefault();
    const key = uiElements.getKey.value;
    if (!key) return browserUiAdapter.updateStatus('Enter a key', true);
    try {
      const result = await getValue(key);
      uiElements.getResult && (uiElements.getResult.textContent = result ?? 'Not found');
      browserUiAdapter.updateStatus(result!=null?'Retrieved':'Not found');
    } catch {};
  });

  document.addEventListener('api:new_peer', e => attemptAutomaticPeerConnection(e.detail.peerId));
  document.addEventListener('api:registered', e => e.detail.peers.forEach((id,i) => setTimeout(()=>attemptAutomaticPeerConnection(id),i*1000)));
}

// Auto-connect helper
function attemptAutomaticPeerConnection(peerId) {
  if (!peerId || connectionAttempts.has(peerId) || !window.dhtInstance) return;
  if (window.dhtInstance.peers.has(peerId)) return;
  const should = window.dhtInstance.nodeId < peerId;
  if (!should) return;
  connectionAttempts.add(peerId);
  setTimeout(() => {
    connectToPeer(peerId).finally(() => connectionAttempts.delete(peerId));
  },1000);
}

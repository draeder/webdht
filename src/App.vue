<template>
  <main class="grid" style="gap: 18px;">
    <header class="flex between card">
      <div>
        <h1>WebDHT Mesh Console</h1>
        <small>Vue 3 + Vite using PartialMesh, GossipProtocol, UniWRTC, and Unsea</small>
      </div>
      <div class="flex" style="gap: 8px; align-items: flex-start;">
        <span class="badge" :class="meshReady ? 'ok' : 'warn'">
          <span v-if="meshReady">Ready</span>
          <span v-else>Waiting</span>
        </span>
        <span class="badge" :class="statusBadge">
          {{ meshStatusLabel }}
        </span>
      </div>
    </header>

    <section class="grid two">
      <div class="card">
        <div class="flex between" style="margin-bottom: 10px;">
          <h2>Mesh Settings</h2>
          <div class="flex" style="gap: 8px;">
            <button class="secondary" :disabled="!mesh" @click="stopMesh">Stop</button>
            <button :disabled="meshStatus === 'starting'" @click="startMesh">Start</button>
          </div>
        </div>

        <div class="grid two">
          <div>
            <label for="session">Session / room</label>
            <input id="session" v-model="sessionId" placeholder="my-room" />
          </div>
          <div>
            <label for="signal">Signaling server (UniWRTC)</label>
            <input id="signal" v-model="signalingServer" />
          </div>
          <div>
            <label for="minPeers">Min peers</label>
            <input id="minPeers" type="number" min="1" v-model.number="minPeers" />
          </div>
          <div>
            <label for="maxPeers">Max peers</label>
            <input id="maxPeers" type="number" min="1" v-model.number="maxPeers" />
          </div>
          <div>
            <label for="maxHops">Gossip max hops</label>
            <input id="maxHops" type="number" min="1" v-model.number="maxHops" />
          </div>
          <div class="flex" style="gap: 12px; align-items: center; margin-top: 8px;">
            <label class="flex" style="gap: 6px; align-items: center;">
              <input type="checkbox" v-model="autoDiscover" />
              <small>Auto-discover</small>
            </label>
            <label class="flex" style="gap: 6px; align-items: center;">
              <input type="checkbox" v-model="autoConnect" />
              <small>Auto-connect</small>
            </label>
          </div>
        </div>

        <div class="flex" style="gap: 12px; margin-top: 14px; flex-wrap: wrap;">
          <span class="badge">
            SHA1 ID
            <span class="mono">{{ displayPeerId }}</span>
          </span>
          <span class="badge">
            Mesh ID
            <span class="mono">{{ displayMeshId }}</span>
          </span>
          <span class="badge">
            Connected
            <span class="mono">{{ connectedPeers.length }}</span>
          </span>
          <span class="badge">
            Discovered
            <span class="mono">{{ discoveredPeers.length }}</span>
          </span>
          <span class="badge">
            Gossip messages
            <span class="mono">{{ gossipStats.totalMessagesTracked }}</span>
          </span>
        </div>
      </div>

      <div class="card">
        <div class="flex between" style="margin-bottom: 10px;">
          <h2>Identity & Signaling</h2>
          <button class="secondary" @click="regenerateKeys">Regenerate keys</button>
        </div>
        <p style="margin: 0 0 8px;">Unsea-generated signing keypair is used to sign/verify gossip payloads.</p>
        <div class="flex" style="gap: 10px; flex-wrap: wrap;">
          <span class="badge">
            Public key
            <span class="mono">{{ keyPreview }}</span>
          </span>
          <span class="badge" :class="signalingBadge">
            Probe: {{ signalingStatusLabel }}
          </span>
          <button class="secondary" @click="probeSignaling">Probe UniWRTC</button>
        </div>
        <div v-if="signalingRooms.length" class="list" style="margin-top: 12px;">
          <small>Rooms (probe)</small>
          <div v-for="room in signalingRooms" :key="room" class="item mono">{{ room }}</div>
        </div>
      </div>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="flex between" style="margin-bottom: 12px;">
          <h2>Peers & Gossip</h2>
          <button class="secondary" @click="refreshStats" :disabled="!gossip">Refresh stats</button>
        </div>
        <div class="grid two">
          <div>
            <small>Connected peers (SHA1 of peer ID)</small>
            <div class="list">
              <div v-if="!connectedPeersHashed.length" class="item">No peers yet.</div>
              <div v-for="p in connectedPeersHashed" :key="p" class="item mono">{{ p }}</div>
            </div>
          </div>
          <div>
            <small>Discovered peers (SHA1 of peer ID)</small>
            <div class="list">
              <div v-if="!discoveredPeersHashed.length" class="item">Waiting for discovery.</div>
              <div v-for="p in discoveredPeersHashed" :key="p" class="item mono">{{ p }}</div>
            </div>
          </div>
        </div>
        <div style="margin-top: 12px;" class="grid two">
          <div class="item" style="background: var(--surface);">
            <strong>Tracked messages</strong>
            <div class="mono">{{ gossipStats.totalMessagesTracked }}</div>
          </div>
          <div class="item" style="background: var(--surface);">
            <strong>Recent (1m)</strong>
            <div class="mono">{{ gossipStats.recentMessages.length }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="flex between" style="margin-bottom: 10px;">
          <h2>Broadcast Message</h2>
          <button class="secondary" :disabled="!meshReady" @click="sendSample">Send demo ping</button>
        </div>
        <textarea
          class="message-box"
          v-model="messageInput"
          placeholder="Type a message to gossip across the mesh"
        ></textarea>
        <div class="flex" style="gap: 10px; margin-top: 10px;">
          <button :disabled="!gossip || sending || !messageInput.trim()" @click="sendMessage">
            {{ sending ? 'Sending...' : 'Send over Gossip' }}
          </button>
          <button class="secondary" :disabled="!mesh" @click="stopMesh">Disconnect mesh</button>
        </div>
      </div>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="flex between" style="margin-bottom: 10px;">
          <h2>Message Feed</h2>
          <small>Newest first. Shows Unsea signature status.</small>
        </div>
        <div class="list">
          <div v-if="!messages.length" class="item">No messages yet.</div>
          <div v-for="msg in messages" :key="msg.id" class="item">
            <div class="flex between" style="gap: 10px; align-items: center;">
              <strong>{{ msg.payload.text }}</strong>
              <span class="badge" :class="msg.verified ? 'ok' : 'err'">{{ msg.verified ? 'Verified' : 'Failed' }}</span>
            </div>
            <small>
              from {{ msg.payload.from }} · hops {{ msg.hops }} · {{ formatTime(msg.payload.ts) }}
              <span v-if="msg.local"> · local</span>
            </small>
            <div class="mono" style="margin-top: 6px;">ID: {{ msg.id }}</div>
          </div>
        </div>
      </div>

      <div class="card log">
        <div class="flex between" style="margin-bottom: 10px;">
          <h2>Activity Log</h2>
          <button class="secondary" @click="logs = []">Clear</button>
        </div>
        <div class="log">
          <div v-for="(entry, idx) in logs" :key="idx" class="entry">
            <div class="mono">{{ entry.ts }} — {{ entry.text }}</div>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PartialMesh } from 'partialmesh';
import { GossipProtocol } from 'gossip-protocol';
import UniWRTCClient from 'uniwrtc/client-browser.js';
import { generateRandomPair, signMessage, verifyMessage } from 'unsea';

const sessionId = ref('webdht-room');
const signalingServer = ref('wss://signal.peer.ooo/ws');
const minPeers = ref(2);
const maxPeers = ref(8);
const maxHops = ref(5);
const autoDiscover = ref(true);
const autoConnect = ref(true);

const mesh = ref(null);
const gossip = ref(null);
const meshStatus = ref('idle');
const meshReady = ref(false);
const meshClientId = ref('');
const peerIdOverride = ref('');
const connectedPeers = ref([]);
const discoveredPeers = ref([]);
const connectedPeersHashed = ref([]);
const discoveredPeersHashed = ref([]);

const keys = ref(null);
const messageInput = ref('');
const messages = ref([]);
const seenMessageIds = new Set();
const sentMessageIds = new Set();
const peerIdHashCache = new Map();
const peerIdHashPromises = new Map();
const sending = ref(false);
const logs = ref([]);

const signalingStatus = ref('idle');
const signalingRooms = ref([]);
const signalingClient = ref(null);

const keyPreview = computed(() => {
  if (!keys.value?.pub) return 'not ready';
  return `${keys.value.pub.toString().slice(0, 14)}…`;
});

const displayPeerId = computed(() => peerIdOverride.value || meshClientId.value || '—');
const displayMeshId = computed(() => meshClientId.value || '—');

const statusBadge = computed(() => {
  if (meshStatus.value === 'connected') return 'ok';
  if (meshStatus.value === 'idle') return '';
  return 'warn';
});

const signalingBadge = computed(() => {
  if (signalingStatus.value === 'connected') return 'ok';
  if (signalingStatus.value === 'error') return 'err';
  return 'warn';
});

const meshStatusLabel = computed(() => {
  switch (meshStatus.value) {
    case 'starting':
      return 'Starting mesh';
    case 'signaling':
      return 'Signaling connected';
    case 'connected':
      return 'Mesh online';
    case 'idle':
    default:
      return 'Stopped';
  }
});

const signalingStatusLabel = computed(() => {
  switch (signalingStatus.value) {
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
});

const gossipStats = computed(() => {
  if (!gossip.value) {
    return { totalMessagesTracked: 0, recentMessages: [], connectedPeers: connectedPeers.value.length, discoveredPeers: discoveredPeers.value.length };
  }
  try {
    return gossip.value.getStats();
  } catch {
    return { totalMessagesTracked: 0, recentMessages: [], connectedPeers: connectedPeers.value.length, discoveredPeers: discoveredPeers.value.length };
  }
});

const formatTime = (ts) => new Date(ts).toLocaleTimeString();

function addLog(text) {
  const stamp = new Date().toLocaleTimeString();
  logs.value.unshift({ ts: stamp, text });
  if (logs.value.length > 120) logs.value.pop();
}

async function regenerateKeys() {
  keys.value = await generateRandomPair();
  peerIdOverride.value = await computePeerIdFromKeys(keys.value);
  meshClientId.value = peerIdOverride.value || meshClientId.value;
  addLog('Generated fresh Unsea keypair');
}

async function updatePeerLists() {
  if (!mesh.value) {
    connectedPeers.value = [];
    discoveredPeers.value = [];
    connectedPeersHashed.value = [];
    discoveredPeersHashed.value = [];
    return;
  }
  const connectedRaw = mesh.value.getConnectedPeers();
  const discoveredRaw = mesh.value.getDiscoveredPeers();
  connectedPeers.value = connectedRaw;
  discoveredPeers.value = discoveredRaw;
  connectedPeersHashed.value = await hashIdList(connectedRaw);
  discoveredPeersHashed.value = await hashIdList(discoveredRaw);
}

async function startMesh() {
  try {
    await ensureKeys();
    await stopMesh();
    meshStatus.value = 'starting';
    meshReady.value = false;
    connectedPeers.value = [];
    discoveredPeers.value = [];

    const signalUrl = buildSignalingUrl(signalingServer.value, sessionId.value || 'webdht-room');

    const instance = new PartialMesh({
      signalingServer: signalUrl,
      sessionId: sessionId.value || 'webdht-room',
      minPeers: Number(minPeers.value) || 2,
      maxPeers: Number(maxPeers.value) || 8,
      autoDiscover: autoDiscover.value,
      autoConnect: autoConnect.value,
    });

    // Force our SHA1-derived ID as the mesh client ID so all peers see the same identifier across browsers.
    if (peerIdOverride.value) {
      instance.clientId = peerIdOverride.value;
      instance.id = peerIdOverride.value;
      if (typeof instance.setClientId === 'function') {
        instance.setClientId(peerIdOverride.value);
      }
    }

    wireMeshEvents(instance);
    mesh.value = instance;
    await instance.init();

    gossip.value = new GossipProtocol(instance, { maxHops: Number(maxHops.value) || 5 });
    gossip.value.on('messageReceived', handleGossipMessage);

    meshStatus.value = 'connected';
    // Allow sending even before minPeers reached; mesh:ready will flip flag once peers satisfy threshold.
    meshReady.value = true;
    if (!peerIdOverride.value && keys.value) {
      peerIdOverride.value = await computePeerIdFromKeys(keys.value);
    }
    // Force display ID to derived SHA1 for consistency with user request.
    if (peerIdOverride.value) {
      meshClientId.value = peerIdOverride.value;
    }
    addLog('Mesh initialized and gossip attached');
  } catch (err) {
    meshStatus.value = 'idle';
    addLog(`Mesh start failed: ${err?.message || err}`);
  }
}

async function ensureKeys() {
  if (!keys.value) {
    keys.value = await generateRandomPair();
    peerIdOverride.value = await computePeerIdFromKeys(keys.value);
    meshClientId.value = peerIdOverride.value || meshClientId.value;
  }
}

function wireMeshEvents(instance) {
  instance.on('signaling:connected', (data) => {
    meshStatus.value = 'signaling';
    // Preserve derived SHA1 ID if present; otherwise fall back to signaling-provided ID.
    meshClientId.value = peerIdOverride.value || data?.clientId || '';
    addLog(`Signaling connected as ${meshClientId.value}`);
  });

  instance.on('signaling:disconnected', () => {
    meshStatus.value = 'idle';
    addLog('Signaling disconnected');
  });

  instance.on('peer:connected', async (peerId) => {
    updatePeerLists();
    const hashedId = await getHashedPeerId(peerId);
    addLog(`Peer connected: ${hashedId}`);
  });

  instance.on('peer:disconnected', async (peerId) => {
    updatePeerLists();
    const hashedId = await getHashedPeerId(peerId);
    addLog(`Peer disconnected: ${hashedId}`);
  });

  instance.on('peer:data', async ({ peerId }) => {
    const hashedId = await getHashedPeerId(peerId);
    addLog(`Data received from ${hashedId}`);
  });

  instance.on('mesh:ready', () => {
    meshReady.value = true;
    meshStatus.value = 'connected';
    addLog('Mesh reached minPeers');
  });

  instance.on('peer:discovered', () => updatePeerLists());
  instance.on('signaling:error', (err) => addLog(`Signaling error: ${err}`));
}

async function stopMesh() {
  try {
    if (gossip.value) {
      gossip.value.destroy();
      gossip.value = null;
    }
    if (mesh.value) {
      mesh.value.destroy();
      mesh.value = null;
    }
  } finally {
    meshStatus.value = 'idle';
    meshReady.value = false;
    meshClientId.value = '';
    connectedPeers.value = [];
    discoveredPeers.value = [];
  }
}

async function handleGossipMessage({ message, local, fromPeer }) {
  const id = message?.id;
  
  // Prevent duplicate messages - check immediately and mark as seen
  if (!id || seenMessageIds.has(id)) {
    return;
  }
  seenMessageIds.add(id);

  const envelope = message.data || {};
  const payload = envelope.payload || {};
  let verified = false;

  try {
    if (envelope.signature && envelope.pub && envelope.payload) {
      const serialized = JSON.stringify(envelope.payload);
      verified = await verifyMessage(serialized, envelope.signature, envelope.pub);
    }
  } catch {
    verified = false;
  }

  // Determine if this is our message by checking sentMessageIds
  const isOurMessage = sentMessageIds.has(id);
  let from = 'unknown';
  
  if (isOurMessage) {
    from = 'You';
  } else if (fromPeer) {
    // Always use fromPeer (the actual connection ID) for remote messages
    from = await getHashedPeerId(fromPeer);
  } else if (payload.from) {
    // Fallback when some browsers do not supply fromPeer
    from = await getHashedPeerId(payload.from);
  }

  messages.value.unshift({
    id,
    payload: {
      text: payload.text || '[no text]',
      from,
      ts: payload.ts || message.timestamp,
    },
    hops: message.hops,
    local: isOurMessage,
    verified,
  });

  if (messages.value.length > 100) messages.value.pop();
}

async function sendMessage() {
  if (!gossip.value) return;
  const text = messageInput.value.trim();
  if (!text) return;
  sending.value = true;

  const payload = {
    text,
    from: displayPeerId.value,
    ts: Date.now(),
  };
  const serialized = JSON.stringify(payload);
  const signature = await signMessage(serialized, keys.value.priv);
  const envelope = { payload, signature, pub: keys.value.pub };

  try {
    const id = gossip.value.broadcast(envelope, { kind: 'chat' });
    sentMessageIds.add(id); // Track this as sent by us
    addLog(`Broadcast message sent`);
    messageInput.value = '';
  } catch (err) {
    addLog(`Send failed: ${err?.message || err}`);
  } finally {
    sending.value = false;
  }
}

async function sendSample() {
  messageInput.value = 'ping from ' + (meshClientId.value || 'anon');
  await sendMessage();
}

async function probeSignaling() {
  disconnectProbe();
  signalingStatus.value = 'connecting';
  signalingRooms.value = [];

  const url = buildSignalingUrl(signalingServer.value, sessionId.value || 'webdht-room');
  const client = new UniWRTCClient(url, { autoReconnect: false });
  signalingClient.value = client;

  client.on('connected', () => {
    signalingStatus.value = 'connected';
    addLog('UniWRTC probe connected');
    try {
      client.listRooms?.();
    } catch {
      // ignore
    }
  });

  client.on('room-list', (data) => {
    if (Array.isArray(data?.rooms)) {
      signalingRooms.value = data.rooms;
    }
  });

  client.on('error', (err) => {
    signalingStatus.value = 'error';
    addLog(`UniWRTC probe error: ${err}`);
  });

  client.on('disconnected', () => {
    if (signalingStatus.value !== 'error') {
      signalingStatus.value = 'idle';
    }
  });

  try {
    await client.connect();
  } catch (err) {
    signalingStatus.value = 'error';
    addLog(`Probe connect failed: ${err?.message || err}`);
  }
}

function disconnectProbe() {
  if (signalingClient.value) {
    try {
      signalingClient.value.disconnect();
    } catch {
      // ignore
    }
    signalingClient.value = null;
  }
}

function refreshStats() {
  updatePeerLists();
}

async function hashIdList(ids) {
  return Promise.all(ids.map((id) => getHashedPeerId(id)));
}

async function getHashedPeerId(id) {
  if (!id) return '';
  if (peerIdHashCache.has(id)) return peerIdHashCache.get(id);
  if (peerIdHashPromises.has(id)) return peerIdHashPromises.get(id);

  const pending = sha1String(id)
    .then((hashed) => {
      peerIdHashCache.set(id, hashed);
      peerIdHashPromises.delete(id);
      return hashed;
    })
    .catch((err) => {
      peerIdHashPromises.delete(id);
      addLog(`Hash failed for ${id}: ${err?.message || err}`);
      return String(id);
    });

  peerIdHashPromises.set(id, pending);
  return pending;
}

async function sha1String(str) {
  try {
    const data = new TextEncoder().encode(str ?? '');
    const digest = await crypto.subtle.digest('SHA-1', data);
    return bufferToHex(digest);
  } catch (err) {
    addLog(`Failed to hash peer id: ${err?.message || err}`);
    return String(str ?? '');
  }
}

async function computePeerIdFromKeys(k) {
  try {
    const pub = typeof k?.pub === 'string' ? k.pub : JSON.stringify(k?.pub ?? '');
    const data = new TextEncoder().encode(pub);
    const digest = await crypto.subtle.digest('SHA-1', data);
    return bufferToHex(digest);
  } catch (err) {
    addLog(`Failed to derive peer ID: ${err?.message || err}`);
    return '';
  }
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16).padStart(2, '0');
    hex += h;
  }
  return hex;
}

function buildSignalingUrl(raw, room) {
  try {
    const url = new URL(raw, window.location.href);

    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';

    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (normalizedPath === '' || normalizedPath === '/') {
      url.pathname = '/ws';
    }
    if (normalizedPath !== '' && normalizedPath !== '/' && normalizedPath !== '/ws') {
      // Leave custom paths intact but ensure no trailing slashes
      url.pathname = normalizedPath;
    }

    if (!url.searchParams.get('room')) {
      url.searchParams.set('room', room || 'webdht-room');
    }

    return url.toString();
  } catch (err) {
    addLog(`Invalid signaling URL: ${err?.message || err}`);
    return raw;
  }
}

onMounted(async () => {
  await regenerateKeys();
  addLog('Ready to start mesh');
});

onBeforeUnmount(() => {
  stopMesh();
  disconnectProbe();
});
</script>

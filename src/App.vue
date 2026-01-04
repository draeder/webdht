<template>
  <div id="app" class="container">
    <header class="header">
      <h1>WebDHT</h1>
      <div class="node-info">
        <p>Node ID: <code>{{ nodeIdShort }}</code></p>
        <p>
          Pub Key:
          <code :title="publicKey">{{ publicKeyShort }}</code>
        </p>
        <p>Connected Peers: <strong>{{ connectedPeers.length }}</strong></p>
        <p class="status" :class="connected ? 'online' : 'offline'">
          {{ connected ? '🟢 Online' : '🔴 Offline' }}
        </p>
        <button @click="openNewWindow" class="btn btn-primary">🚀 Open 2nd Window to Test</button>
      </div>
    </header>

    <main class="main">
      <section class="section settings">
        <h2>Settings</h2>
        <div class="settings-group">
          <label>Session/Room ID:</label>
          <input v-model="signalingRoom" type="text" placeholder="webdht-test" class="input" />
        </div>
        <div class="settings-group">
          <label>Signaling Server:</label>
          <input v-model="signalingServer" type="text" placeholder="wss://signal.peer.ooo" class="input" />
        </div>
        <div class="settings-group">
          <label>IndexedDB quota:</label>
          <select v-model="idbQuotaLevel" class="select" @change="onQuotaChanged">
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
          </select>
        </div>
        <div class="settings-group">
          <button @click="reconnectSignaling" class="btn">Reconnect</button>
        </div>
      </section>

      <section class="section storage">
        <h2>Storage</h2>
        <div class="settings-group">
          <label>Space:</label>
          <select v-model="storageSpace" class="select">
            <option value="public">public</option>
            <option value="user">user</option>
            <option value="private">private</option>
            <option value="frozen">frozen</option>
          </select>
        </div>
        <div class="settings-group">
          <label>Key:</label>
          <input v-model="storageKey" type="text" placeholder="my-key" class="input" />
        </div>
        <div class="settings-group">
          <label>Value:</label>
          <input v-model="storageValue" type="text" placeholder="my-value" class="input" />
        </div>
        <div class="settings-group" style="display:flex; gap:0.5rem;">
          <button @click="putStorage" class="btn">Put</button>
          <button @click="getStorage" class="btn">Get</button>
          <button @click="toggleStorageSubscribe" class="btn">
            {{ isSubscribedToCurrent ? 'Unsubscribe' : 'Subscribe' }}
          </button>
        </div>
        <div v-if="storageSubscribedCanonicalKey" class="empty" style="margin-top:0.5rem;">
          <p>Subscribed: {{ storageSubscribedCanonicalKey }}</p>
        </div>
        <div v-if="storageStatus" class="empty" style="margin-top:0.5rem;">
          <p>{{ storageStatus }}</p>
        </div>
        <div v-if="storageResult !== ''" class="empty" style="margin-top:0.5rem;">
          <p>Result:</p>
          <p style="word-break: break-word;">{{ storageResult }}</p>
        </div>
      </section>

      <section class="section peers">
        <h2>Peers</h2>
        <div v-if="allPeers.length === 0" class="empty">
          <p>No peers yet. Waiting for peers to join...</p>
        </div>
        <ul v-else class="peer-list">
          <li v-for="peer in allPeers" :key="peer" class="peer-item">
            <span class="peer-id">{{ peer.substring(0, 16) }}...</span>
            <span class="peer-kind">{{ connectedPeers.includes(peer) ? 'direct' : 'indirect' }}</span>
          </li>
        </ul>
      </section>

      <section class="section messaging">
        <h2>Messages</h2>
        <div class="message-box">
          <div v-if="messages.length === 0" class="empty">
            <p>No messages yet</p>
          </div>
          <div v-else class="messages">
            <div v-for="(msg, idx) in messages" :key="idx" class="message" :class="msg.outgoing ? 'outgoing' : 'incoming'">
              <span class="msg-peer">{{ msg.peer.substring(0, 8) }}</span>
              <span class="msg-text">{{ msg.text }}</span>
              <span class="msg-time">{{ msg.time }}</span>
            </div>
          </div>
        </div>
        <div class="message-input">
          <select v-model="selectedPeer" class="select">
            <option value="">Broadcast...</option>
            <option v-for="peer in allPeers" :key="peer" :value="peer">
              {{ peer.substring(0, 12) }}...
            </option>
          </select>
          <input 
            v-model="messageText" 
            @keyup.enter="sendMessage"
            type="text" 
            placeholder="Type message..." 
            class="input"
          />
          <button @click="sendMessage" class="btn">Send</button>
        </div>
      </section>
    </main>

    <footer class="footer">
      <p>WebDHT - P2P Distributed Hash Table</p>
    </footer>
  </div>
</template>

<script>
import { PartialMesh } from './vendor/partialmesh.ts'
import { GossipProtocol } from './vendor/gossip-protocol.ts'
import { generateRandomPair } from 'unsea'
import { IDB_STORES, getQuotaLevel, idbGetAll, idbSet, isIndexedDbAvailable, setQuotaLevel } from './idb.js'

function buildIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ]

  return servers
}

export default {
  name: 'App',
  data() {
    return {
      gossip: null,
      mesh: null,
      nodeIdShort: '',
      identity: null,
      publicKey: '',
      connectedPeers: [],
      // Room roster candidates from signaling (can be stale on public servers).
      discoveredPeers: [],
      // Peer graph gossiped by connected peers: peerId -> { peers: Set<string>, lastSeenAtMs: number }
      peerGraph: new Map(),
      messages: [],
      selectedPeer: '',
      messageText: '',
      storageSpace: 'public',
      storageKey: '',
      storageValue: '',
      storageStatus: '',
      storageResult: '',
      storageSubscribedCanonicalKey: '',
      storageSubscribedSpace: '',
      storageLocal: {
        public: new Map(),
        user: new Map(),
        private: new Map(),
        frozen: new Map(),
      },
      pendingStorageGets: new Map(),
      idbQuotaLevel: 'normal',
      signalingServer: 'wss://signal.peer.ooo/ws',
      signalingRoom: 'webdht-test',
      connected: false,
      signalingWs: null,
      clientId: null,
      peerSyncTimer: null,
      peerGraphTimer: null,
    }
  },
  computed: {
    publicKeyShort() {
      if (!this.publicKey) return ''
      return this.publicKey.length > 22
        ? `${this.publicKey.slice(0, 22)}…`
        : this.publicKey
    },
    allPeers() {
      const unique = new Set([...(this.connectedPeers || []), ...(this.indirectPeers || [])])
      const selfId = this.clientId
      if (selfId) unique.delete(selfId)
      return Array.from(unique)
    },

    isSubscribedToCurrent() {
      const key = String(this.storageKey || '').trim()
      if (!key) return false
      const canonical = this.canonicalStorageKey(this.storageSpace, key)
      return Boolean(this.storageSubscribedCanonicalKey && canonical === this.storageSubscribedCanonicalKey)
    },

    indirectPeers() {
      const selfId = this.clientId
      if (!selfId) return []

      const now = Date.now()
      const ttlMs = 15_000
      const maxHops = 3

      // Build adjacency from recent graph entries.
      const adjacency = new Map()
      for (const [nodeId, entry] of this.peerGraph.entries()) {
        if (!entry || typeof entry !== 'object') continue
        if (typeof entry.lastSeenAtMs !== 'number') continue
        if (now - entry.lastSeenAtMs > ttlMs) continue
        adjacency.set(nodeId, entry.peers)
      }

      // Always include our direct connections.
      adjacency.set(selfId, new Set(this.connectedPeers || []))

      // BFS up to maxHops.
      const visited = new Set([selfId])
      let frontier = new Set([selfId])
      for (let depth = 0; depth < maxHops; depth++) {
        const next = new Set()
        for (const nodeId of frontier) {
          const neighbors = adjacency.get(nodeId)
          if (!neighbors) continue
          for (const raw of neighbors) {
            const peerId = String(raw || '').trim()
            if (!peerId) continue
            if (visited.has(peerId)) continue
            visited.add(peerId)
            next.add(peerId)
          }
        }
        frontier = next
        if (frontier.size === 0) break
      }

      // Remove direct peers + self; remaining are indirect reachable peers.
      for (const p of (this.connectedPeers || [])) visited.delete(p)
      visited.delete(selfId)
      return Array.from(visited)
    },
  },
  mounted() {
    this.initIdentity()
    this.idbQuotaLevel = getQuotaLevel()
    this.loadPersistedUiStorage()
    this.setupMesh()
  },
  methods: {
    applyStorageSubscriptionUpdate(space, canonicalKey, value, source) {
      if (!this.storageSubscribedCanonicalKey) return
      if (String(canonicalKey) !== String(this.storageSubscribedCanonicalKey)) return
      if (String(space) !== String(this.storageSubscribedSpace)) return

      this.storageValue = String(value)
      this.storageResult = String(value)
      this.storageStatus = `Subscription update (${source}) in ${space}`
    },

    async toggleStorageSubscribe() {
      const space = this.storageSpace
      const key = String(this.storageKey || '').trim()
      if (!key) {
        this.storageStatus = 'Key is required to subscribe'
        return
      }
      const canonical = this.canonicalStorageKey(space, key)
      if (!canonical) {
        this.storageStatus = 'Invalid key'
        return
      }

      if (this.storageSubscribedCanonicalKey === canonical && this.storageSubscribedSpace === space) {
        this.storageSubscribedCanonicalKey = ''
        this.storageSubscribedSpace = ''
        this.storageStatus = 'Unsubscribed'
        return
      }

      this.storageSubscribedCanonicalKey = canonical
      this.storageSubscribedSpace = space
      this.storageStatus = `Subscribed to ${canonical}`

      // Event-based: ask the mesh for the current value without using Get/polling.
      // - public/frozen: broadcast a subscription request and accept the first direct response.
      // - user/private: local-only (no broadcast).
      const store = this.storageLocal?.[space]
      if (store && store.has(canonical)) {
        const value = store.get(canonical)
        this.applyStorageSubscriptionUpdate(space, canonical, value, 'local')
        return
      }

      if (space === 'public' || space === 'frozen') {
        const requestId = this.makeRequestId()
        const p = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            this.pendingStorageGets.delete(requestId)
            resolve(null)
          }, 5000)
          this.pendingStorageGets.set(requestId, { resolve, timeout, space, key: canonical })
        })

        try {
          this.gossip.broadcast('', {
            kind: 'storage',
            op: 'sub',
            space,
            key: canonical,
            requester: this.clientId,
            requestId,
          })
        } catch {
          // ignore
        }

        const value = await p
        if (value !== null && value !== undefined) {
          store?.set(canonical, value)
          this.persistUiStorageValue(space, canonical, value)
          this.applyStorageSubscriptionUpdate(space, canonical, value, 'network')
        }
      }
    },
    async loadPersistedUiStorage() {
      if (!isIndexedDbAvailable()) return
      try {
        const rows = await idbGetAll(IDB_STORES.UI)
        if (!Array.isArray(rows) || rows.length === 0) return

        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          const space = String(row.space || '')
          const key = String(row.key || '')
          if (!space || !key) continue
          const store = this.storageLocal?.[space]
          if (!store) continue
          store.set(key, String(row.value ?? ''))
        }
      } catch (err) {
        console.error('Failed to load persisted UI storage', err)
      }
    },

    async persistUiStorageValue(space, canonicalKey, value) {
      if (!isIndexedDbAvailable()) return
      try {
        const record = {
          space: String(space),
          key: String(canonicalKey),
          value: String(value ?? ''),
          timestamp: Date.now(),
        }
        await idbSet(IDB_STORES.UI, record.key, record)
      } catch {
        // best-effort
      }
    },

    onQuotaChanged() {
      // Best-effort: applies to future persistence/evictions.
      this.idbQuotaLevel = setQuotaLevel(this.idbQuotaLevel)
    },
    async initIdentity() {
      try {
        const identity = await generateRandomPair()
        this.identity = identity
        this.publicKey = identity?.pub ? String(identity.pub) : ''
      } catch (err) {
        console.error('Failed to initialize unsea identity', err)
        this.identity = null
        this.publicKey = ''
      }
    },
    async setupMesh() {
      this.mesh = new PartialMesh({
        sessionId: this.signalingRoom,
        signalingServer: this.signalingServer,
        minPeers: 1,
        maxPeers: 10,
        trickle: false,
        connectionTimeoutMs: 30000,
        iceServers: buildIceServers(),
        debug: true,
      })

      this.mesh.on('signaling:connected', (data) => {
        console.log('✅ Connected to signaling server, clientId:', data.clientId)
        this.clientId = data.clientId
        this.nodeIdShort = data.clientId?.substring(0, 8) || ''
        this.connected = true

        // Keep peer lists accurate even when peers leave the room.
        if (this.peerSyncTimer) clearInterval(this.peerSyncTimer)
        this.peerSyncTimer = setInterval(() => {
          try {
            if (!this.mesh) return
            this.connectedPeers = this.mesh.getConnectedPeers()
            this.discoveredPeers = this.mesh.getDiscoveredPeers()
          } catch {
            // best-effort
          }
        }, 1500)

        // Gossip our direct peer list so others can derive indirect peers accurately.
        if (this.peerGraphTimer) clearInterval(this.peerGraphTimer)
        this.peerGraphTimer = setInterval(() => {
          try {
            if (!this.gossip || !this.mesh || !this.clientId) return
            this.gossip.broadcast('', {
              kind: 'peerGraph',
              nodeId: this.clientId,
              peers: this.mesh.getConnectedPeers(),
              ts: Date.now(),
            })
          } catch {
            // best-effort
          }
        }, 2000)
      })

      this.mesh.on('signaling:disconnected', () => {
        console.log('⚠️ Signaling disconnected')
        this.connected = false
        this.clientId = null
        this.nodeIdShort = ''
        this.connectedPeers = []
        this.discoveredPeers = []
        this.peerGraph = new Map()

        if (this.peerSyncTimer) {
          clearInterval(this.peerSyncTimer)
          this.peerSyncTimer = null
        }

        if (this.peerGraphTimer) {
          clearInterval(this.peerGraphTimer)
          this.peerGraphTimer = null
        }
      })

      this.mesh.on('peer:connected', (peerId) => {
        console.log('✅ Peer connected via mesh:', peerId)
        if (!this.connectedPeers.includes(peerId)) {
          this.connectedPeers.push(peerId)
        }

        // Push an update quickly when topology changes.
        try {
          if (this.gossip && this.mesh && this.clientId) {
            this.gossip.broadcast('', {
              kind: 'peerGraph',
              nodeId: this.clientId,
              peers: this.mesh.getConnectedPeers(),
              ts: Date.now(),
            })
          }
        } catch {
          // ignore
        }
      })

      this.mesh.on('peer:discovered', (peerId) => {
        console.log('🔎 Discovered peer:', peerId)
        if (!this.discoveredPeers.includes(peerId)) {
          this.discoveredPeers.push(peerId)
        }
      })

      this.mesh.on('peer:disconnected', (peerId) => {
        console.log('❌ Peer disconnected:', peerId)
        this.connectedPeers = this.connectedPeers.filter(p => p !== peerId)

        // Push an update quickly when topology changes.
        try {
          if (this.gossip && this.mesh && this.clientId) {
            this.gossip.broadcast('', {
              kind: 'peerGraph',
              nodeId: this.clientId,
              peers: this.mesh.getConnectedPeers(),
              ts: Date.now(),
            })
          }
        } catch {
          // ignore
        }
      })

      this.mesh.on('peer:error', (payload) => {
        console.error('Peer error:', payload?.peerId, payload?.error)
      })

      this.mesh.on('signaling:error', (err) => {
        console.error('Signaling error:', err)
      })

      // Initialize gossip protocol
      this.gossip = new GossipProtocol(this.mesh, { maxHops: 3 })

      this.gossip.on('messageReceived', (data) => {
        const { message, local, fromPeer } = data

        const meta = message?.metadata || {}
        const kind = meta?.kind

        // Handle storage control messages (do not show in chat UI)
        if (kind === 'storage') {
          this.handleStorageMessage(message, local)
          return
        }

        if (kind === 'peerGraph') {
          this.handlePeerGraphMessage(message)
          return
        }

        const target = meta?.target
        const isDirect = kind === 'direct' && typeof target === 'string' && target.length > 0

        // For direct messages, only display on the target (unless local).
        if (isDirect && !local) {
          if (!this.clientId || target !== this.clientId) return
        }

        this.messages.push({
          peer: isDirect && local ? target : (message.sender || fromPeer || 'unknown'),
          text: String(message.data),
          outgoing: local,
          time: new Date(message.timestamp).toLocaleTimeString()
        })
      })

      // Initialize and connect to signaling server
      await this.mesh.init()
    },
    openNewWindow() {
      window.open(window.location.href, '_blank')
    },
    async reconnectSignaling() {
      if (this.mesh) {
        this.mesh.destroy()
      }

      if (this.peerSyncTimer) {
        clearInterval(this.peerSyncTimer)
        this.peerSyncTimer = null
      }
      await this.setupMesh()
    },
    sendMessage() {
      if (!this.messageText || !this.mesh) return

      const text = this.messageText

      if (this.selectedPeer) {
        // For direct messages, use gossip so it can reach indirect peers too.
        try {
          this.gossip.direct(this.selectedPeer, text)
        } catch (err) {
          console.error('Failed to send to peer', err)
        }
      } else {
        // Use gossip for broadcast messages
        try {
          this.gossip.broadcast(text)
        } catch (err) {
          console.error('Failed to gossip message', err)
        }
      }

      this.messageText = ''
    },

    handlePeerGraphMessage(message) {
      const meta = message?.metadata || {}
      const nodeId = String(meta?.nodeId || '').trim()
      const peers = Array.isArray(meta?.peers) ? meta.peers : null
      if (!nodeId || !peers) return
      if (this.clientId && nodeId === this.clientId) return

      const normalized = new Set(
        peers
          .map((p) => String(p || '').trim())
          .filter((p) => p && (!this.clientId || p !== this.clientId)),
      )

      this.peerGraph.set(nodeId, { peers: normalized, lastSeenAtMs: Date.now() })
    },

    canonicalStorageKey(space, key) {
      const k = String(key || '').trim()
      const owner = this.clientId || 'unknown'
      if (!k) return ''
      if (space === 'public') return `public:${k}`
      if (space === 'frozen') return `frozen:${k}`
      if (space === 'user') return `user:${owner}:${k}`
      if (space === 'private') return `private:${owner}:${k}`
      return `public:${k}`
    },

    makeRequestId() {
      return `${this.clientId || 'unknown'}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    },

    putStorage() {
      if (!this.gossip) return
      const space = this.storageSpace
      const key = String(this.storageKey || '').trim()
      const value = this.storageValue
      if (!key) {
        this.storageStatus = 'Key is required'
        return
      }
      if (value === undefined || value === null || String(value).length === 0) {
        this.storageStatus = 'Value is required'
        return
      }

      const canonical = this.canonicalStorageKey(space, key)
      const store = this.storageLocal?.[space]
      if (!store) {
        this.storageStatus = 'Unknown space'
        return
      }

      if (space === 'frozen' && store.has(canonical) && store.get(canonical) !== value) {
        this.storageStatus = 'Frozen key already set'
        return
      }

      // user/private are local-only (best-effort privacy without crypto)
      store.set(canonical, value)
      this.persistUiStorageValue(space, canonical, value)
      this.storageStatus = `Stored locally in ${space}`
      this.storageResult = String(value)
      this.applyStorageSubscriptionUpdate(space, canonical, value, 'local')

      if (space === 'public' || space === 'frozen') {
        try {
          this.gossip.broadcast(value, {
            kind: 'storage',
            op: 'put',
            space,
            key: canonical,
            owner: this.clientId,
          })
          this.storageStatus = `Stored in ${space} (broadcast)`
          this.storageResult = String(value)
          this.applyStorageSubscriptionUpdate(space, canonical, value, 'broadcast')
        } catch (err) {
          console.error('Storage put broadcast failed', err)
          this.storageStatus = `Stored locally in ${space}, broadcast failed`
          this.storageResult = String(value)
          this.applyStorageSubscriptionUpdate(space, canonical, value, 'local')
        }
      }
    },

    async getStorage() {
      if (!this.gossip) return
      const space = this.storageSpace
      const key = String(this.storageKey || '').trim()
      if (!key) {
        this.storageStatus = 'Key is required'
        return
      }

      const canonical = this.canonicalStorageKey(space, key)
      const store = this.storageLocal?.[space]
      if (!store) {
        this.storageStatus = 'Unknown space'
        return
      }

      if (store.has(canonical)) {
        const value = store.get(canonical)
        this.storageValue = String(value)
        this.storageStatus = `Found locally in ${space}`
        this.storageResult = String(value)
        this.applyStorageSubscriptionUpdate(space, canonical, value, 'local')
        return
      }

      if (!(space === 'public' || space === 'frozen')) {
        this.storageStatus = `Not found locally in ${space} (not broadcast)`
        this.storageResult = ''
        return
      }

      const requestId = this.makeRequestId()
      this.storageStatus = `Looking up in ${space}...`

      const p = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingStorageGets.delete(requestId)
          resolve(null)
        }, 5000)
        this.pendingStorageGets.set(requestId, { resolve, timeout, space, key: canonical })
      })

      try {
        this.gossip.broadcast('', {
          kind: 'storage',
          op: 'get',
          space,
          key: canonical,
          requester: this.clientId,
          requestId,
        })
      } catch (err) {
        console.error('Storage get broadcast failed', err)
      }

      const value = await p
      if (value === null || value === undefined) {
        this.storageStatus = `Not found in ${space}`
        this.storageResult = ''
        return
      }
      store.set(canonical, value)
      this.persistUiStorageValue(space, canonical, value)
      this.storageValue = String(value)
      this.storageStatus = `Found in ${space}`
      this.storageResult = String(value)
      this.applyStorageSubscriptionUpdate(space, canonical, value, 'network')
    },

    handleStorageMessage(message, local) {
      const meta = message?.metadata || {}
      const op = meta?.op
      const space = meta?.space
      const key = meta?.key

      if (!space || !key) return
      const store = this.storageLocal?.[space]
      if (!store) return

      if (op === 'put') {
        // Accept public/frozen puts from network.
        if (!(space === 'public' || space === 'frozen')) return
        const incomingValue = String(message.data)
        if (space === 'frozen' && store.has(key) && store.get(key) !== incomingValue) {
          return
        }
        store.set(key, incomingValue)
        this.persistUiStorageValue(space, key, incomingValue)
        this.applyStorageSubscriptionUpdate(space, key, incomingValue, local ? 'local' : 'network')
        return
      }

      if (op === 'get') {
        // Respond only for public/frozen.
        if (!(space === 'public' || space === 'frozen')) return
        const requester = meta?.requester
        const requestId = meta?.requestId
        if (!requester || !requestId) return
        if (!store.has(key)) return

        const value = store.get(key)
        try {
          // Respond directly (multi-hop) so we don't spam the whole room.
          this.gossip.direct(requester, String(value), {
            kind: 'storage',
            op: 'resp',
            space,
            key,
            requester,
            requestId,
          })
        } catch {
          // ignore
        }
        return
      }

      if (op === 'sub') {
        // Respond only for public/frozen.
        if (!(space === 'public' || space === 'frozen')) return
        const requester = meta?.requester
        const requestId = meta?.requestId
        if (!requester || !requestId) return
        if (!store.has(key)) return

        const value = store.get(key)
        try {
          this.gossip.direct(requester, String(value), {
            kind: 'storage',
            op: 'resp',
            space,
            key,
            requester,
            requestId,
          })
        } catch {
          // ignore
        }
        return
      }

      if (op === 'resp') {
        const requestId = meta?.requestId
        const pending = requestId ? this.pendingStorageGets.get(requestId) : null
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pendingStorageGets.delete(requestId)
        pending.resolve(String(message.data))
      }
    }
  }
}
</script>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body, html {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0a0e27;
  color: #e0e6ed;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.header {
  background: linear-gradient(135deg, #1a1f3a 0%, #16213e 100%);
  padding: 2rem;
  border-bottom: 1px solid #3a4655;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.header h1 {
  font-size: 2.5rem;
  margin-bottom: 1rem;
  color: #00d4ff;
  font-weight: 700;
  letter-spacing: 2px;
}

.node-info {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
}

.node-info p {
  font-size: 0.95rem;
  color: #b8c5d6;
}

.node-info code {
  background: #0d1b2a;
  padding: 0.25rem 0.5rem;
  border-radius: 3px;
  color: #00d4ff;
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 0.85rem;
}

.status {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.status.online {
  color: #00ff88;
}

.status.offline {
  color: #ff4444;
}

.main {
  flex: 1;
  padding: 2rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 2rem;
}

.section {
  background: #111827;
  border: 1px solid #2d3748;
  border-radius: 8px;
  padding: 1.5rem;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.section h2 {
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
  color: #00d4ff;
  border-bottom: 2px solid #00d4ff;
  padding-bottom: 0.5rem;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.settings-group label {
  font-size: 0.95rem;
  color: #b8c5d6;
  font-weight: 500;
}

.input {
  padding: 0.75rem;
  background: #0d1b2a;
  border: 1px solid #2d3748;
  border-radius: 4px;
  color: #e0e6ed;
  font-size: 0.95rem;
}

.input:focus {
  outline: none;
  border-color: #00d4ff;
  box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.1);
}

.btn {
  padding: 0.75rem 1.5rem;
  background: linear-gradient(135deg, #00d4ff 0%, #0099cc 100%);
  border: none;
  border-radius: 4px;
  color: #000;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 212, 255, 0.3);
}

.btn:active {
  transform: translateY(0);
}

.empty {
  padding: 2rem;
  text-align: center;
  color: #738aae;
}

.peer-list {
  list-style: none;
}

.peer-item {
  padding: 0.75rem;
  background: #0d1b2a;
  border-left: 3px solid #00d4ff;
  margin-bottom: 0.5rem;
  border-radius: 3px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.peer-id {
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 0.85rem;
  color: #00d4ff;
}

.message-box {
  background: #0d1b2a;
  border: 1px solid #2d3748;
  border-radius: 4px;
  height: 300px;
  overflow-y: auto;
  margin-bottom: 1rem;
  padding: 1rem;
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.message {
  padding: 0.75rem;
  border-radius: 4px;
  background: #111827;
  border-left: 3px solid #738aae;
}

.message.outgoing {
  border-left-color: #00ff88;
  margin-left: 2rem;
}

.message.incoming {
  border-left-color: #00d4ff;
  margin-right: 2rem;
}

.msg-peer {
  display: block;
  font-size: 0.8rem;
  color: #738aae;
  margin-bottom: 0.25rem;
}

.msg-text {
  display: block;
  color: #e0e6ed;
  word-wrap: break-word;
}

.msg-time {
  display: block;
  font-size: 0.75rem;
  color: #4a5568;
  margin-top: 0.25rem;
}

.message-input {
  display: flex;
  gap: 0.5rem;
}

.select {
  padding: 0.75rem;
  background: #0d1b2a;
  border: 1px solid #2d3748;
  border-radius: 4px;
  color: #e0e6ed;
  font-size: 0.95rem;
  min-width: 150px;
}

.select:focus {
  outline: none;
  border-color: #00d4ff;
}

.footer {
  background: #0a0e27;
  border-top: 1px solid #3a4655;
  padding: 1.5rem;
  text-align: center;
  color: #738aae;
  font-size: 0.9rem;
}
</style>

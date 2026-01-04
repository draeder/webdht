<template>
  <div id="app" class="container">
    <header class="header">
      <h1>WebDHT</h1>
      <div class="node-info">
        <p>Node ID: <code>{{ nodeIdShort }}</code></p>
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
          <button @click="reconnectSignaling" class="btn">Reconnect</button>
        </div>
      </section>

      <section class="section peers">
        <h2>Connected Peers</h2>
        <div v-if="connectedPeers.length === 0" class="empty">
          <p>No connected peers yet. Waiting for peers to join...</p>
        </div>
        <ul v-else class="peer-list">
          <li v-for="peer in connectedPeers" :key="peer" class="peer-item">
            <span class="peer-id">{{ peer.substring(0, 16) }}...</span>
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
            <option v-for="peer in connectedPeers" :key="peer" :value="peer">
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
      connectedPeers: [],
      messages: [],
      selectedPeer: '',
      messageText: '',
      signalingServer: 'wss://signal.peer.ooo/ws',
      signalingRoom: 'webdht-test',
      connected: false,
      signalingWs: null,
      clientId: null,
    }
  },
  mounted() {
    this.setupMesh()
  },
  methods: {
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
      })

      this.mesh.on('signaling:disconnected', () => {
        console.log('⚠️ Signaling disconnected')
        this.connected = false
        this.clientId = null
        this.nodeIdShort = ''
        this.connectedPeers = []
      })

      this.mesh.on('peer:connected', (peerId) => {
        console.log('✅ Peer connected via mesh:', peerId)
        if (!this.connectedPeers.includes(peerId)) {
          this.connectedPeers.push(peerId)
        }
      })

      this.mesh.on('peer:discovered', (peerId) => {
        console.log('🔎 Discovered peer:', peerId)
      })

      this.mesh.on('peer:disconnected', (peerId) => {
        console.log('❌ Peer disconnected:', peerId)
        this.connectedPeers = this.connectedPeers.filter(p => p !== peerId)
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
        this.messages.push({
          peer: message.sender || fromPeer || 'unknown',
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
      await this.setupMesh()
    },
    sendMessage() {
      if (!this.messageText || !this.mesh) return

      const text = this.messageText

      if (this.selectedPeer) {
        // For direct messages, we still use mesh.send since gossip is for broadcast
        try {
          this.mesh.send(this.selectedPeer, text)
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

      this.messages.push({
        peer: this.selectedPeer || 'broadcast',
        text,
        outgoing: true,
        time: new Date().toLocaleTimeString()
      })

      this.messageText = ''
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

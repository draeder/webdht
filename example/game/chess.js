/**
 * WebDHT Chess Game - Multiplayer chess using distributed hash table
 */

import WebDHT, { generateRandomId } from "../src/index.js";
import { ChessEngine, PIECES, COLORS, GAME_STATES, PIECE_SYMBOLS } from "./chess-engine.js";
import dhtConnectionManager from "./dht-connection-manager.js";

// Game configuration
const GAME_CONFIG = {
    MATCHMAKING_KEY: 'chess_matchmaking',
    GAME_TIMEOUT: 30000, // 30 seconds for game responses
    HEARTBEAT_INTERVAL: 5000, // 5 seconds
    TIME_CONTROL: 15 * 60 * 1000, // 15 minutes per player
};

// Message types
const MESSAGE_TYPES = {
    GAME_INVITE: 'game_invite',
    GAME_ACCEPT: 'game_accept',
    GAME_DECLINE: 'game_decline',
    GAME_START: 'game_start',
    MOVE: 'move',
    CHAT: 'chat',
    RESIGN: 'resign',
    DRAW_OFFER: 'draw_offer',
    DRAW_ACCEPT: 'draw_accept',
    DRAW_DECLINE: 'draw_decline',
    HEARTBEAT: 'heartbeat',
    REMATCH: 'rematch'
};

class ChessGame {
    constructor() {
        this.dht = null;
        this.engine = new ChessEngine();
        this.gameId = null;
        this.opponentId = null;
        this.playerColor = null;
        this.gameState = 'disconnected';
        this.selectedSquare = null;
        this.validMoves = [];
        this.isSearching = false;
        this.gameInvites = new Map();
        this.chatMessages = [];
        this.timeLeft = { white: GAME_CONFIG.TIME_CONTROL, black: GAME_CONFIG.TIME_CONTROL };
        this.gameTimer = null;
        this.lastMoveTime = null;

        this.initializeUI();
        this.setupEventListeners();
        
        // Auto-connect to DHT when page loads
        this.autoConnect();
    }

    async autoConnect() {
        // Check if we have connection info from the main tab
        const existingConnection = dhtConnectionManager.checkExistingConnection();
        
        if (existingConnection) {
            this.ui.status.textContent = 'Connecting to existing DHT network...';
            this.ui.signalingUrl.value = existingConnection.signalingUrl;
            
            try {
                this.dht = await dhtConnectionManager.connect(existingConnection.signalingUrl);
                this.setupChessEventListeners();
                this.onDHTConnected();
                this.log('Connected to existing DHT network from main tab');
                return;
            } catch (error) {
                console.error('Failed to connect to existing network:', error);
                this.ui.status.textContent = 'Failed to connect to existing network, will create new connection...';
            }
        }
        
        // Wait a bit for UI to be ready, then connect automatically
        setTimeout(() => {
            this.connectToSignaling();
        }, 1000);
    }

    initializeUI() {
        this.ui = {
            // Connection elements
            signalingUrl: document.getElementById('signalingUrl'),
            connectSignalingBtn: document.getElementById('connectSignalingBtn'),
            peerId: document.getElementById('peerId'),
            status: document.getElementById('status'),
            peerCount: document.getElementById('peerCount'),

            // Matchmaking elements
            findGameBtn: document.getElementById('findGameBtn'),
            cancelSearchBtn: document.getElementById('cancelSearchBtn'),
            createGameBtn: document.getElementById('createGameBtn'),
            searchStatus: document.getElementById('searchStatus'),
            gameInvites: document.getElementById('gameInvites'),
            gamesList: document.getElementById('gamesList'),

            // Game elements
            gameInfo: document.getElementById('gameInfo'),
            gameStatus: document.getElementById('gameStatus'),
            whitePlayer: document.getElementById('whitePlayer'),
            blackPlayer: document.getElementById('blackPlayer'),
            whiteTime: document.getElementById('whiteTime'),
            blackTime: document.getElementById('blackTime'),
            chessBoard: document.getElementById('chessBoard'),
            resignBtn: document.getElementById('resignBtn'),
            drawBtn: document.getElementById('drawBtn'),
            rematchBtn: document.getElementById('rematchBtn'),
            moveHistory: document.getElementById('moveHistory'),

            // Chat elements
            chatMessages: document.getElementById('chatMessages'),
            chatInput: document.getElementById('chatInput'),
            sendChatBtn: document.getElementById('sendChatBtn'),

            // Debug elements
            toggleDebugBtn: document.getElementById('toggleDebugBtn'),
            dhtStats: document.getElementById('dhtStats'),
            networkMessages: document.getElementById('networkMessages'),

            // Modals
            inviteModal: document.getElementById('inviteModal'),
            inviterName: document.getElementById('inviterName'),
            acceptInviteBtn: document.getElementById('acceptInviteBtn'),
            declineInviteBtn: document.getElementById('declineInviteBtn'),
            gameEndModal: document.getElementById('gameEndModal'),
            gameEndTitle: document.getElementById('gameEndTitle'),
            gameEndMessage: document.getElementById('gameEndMessage'),
            newGameBtn: document.getElementById('newGameBtn'),
            closeGameBtn: document.getElementById('closeGameBtn')
        };

        this.createChessBoard();
        this.updateUI();
        
        // Show auto-connecting status
        this.ui.status.textContent = 'Auto-connecting...';
    }

    setupEventListeners() {
        // Connection events
        this.ui.connectSignalingBtn.addEventListener('click', () => this.connectToSignaling());

        // Matchmaking events
        this.ui.findGameBtn.addEventListener('click', () => this.findGame());
        this.ui.cancelSearchBtn.addEventListener('click', () => this.cancelSearch());
        this.ui.createGameBtn.addEventListener('click', () => this.createPrivateGame());

        // Game events
        this.ui.resignBtn.addEventListener('click', () => this.resign());
        this.ui.drawBtn.addEventListener('click', () => this.offerDraw());
        this.ui.rematchBtn.addEventListener('click', () => this.offerRematch());

        // Chat events
        this.ui.sendChatBtn.addEventListener('click', () => this.sendChat());
        this.ui.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendChat();
        });

        // Debug events
        this.ui.toggleDebugBtn.addEventListener('click', () => this.toggleDebug());

        // Modal events
        this.ui.acceptInviteBtn.addEventListener('click', () => this.acceptInvite());
        this.ui.declineInviteBtn.addEventListener('click', () => this.declineInvite());
        this.ui.newGameBtn.addEventListener('click', () => this.findGame());
        this.ui.closeGameBtn.addEventListener('click', () => this.closeGameEndModal());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearSelection();
            }
        });
    }

    async connectToSignaling() {
        try {
            this.ui.connectSignalingBtn.disabled = true;
            this.ui.status.textContent = 'Connecting...';

            const signalingUrl = this.ui.signalingUrl.value;
            
            // Use the connection manager to connect
            this.dht = await dhtConnectionManager.connect(signalingUrl);
            
            // Set up additional event listeners specific to chess
            this.setupChessEventListeners();
            
            this.onDHTConnected();

        } catch (error) {
            console.error('Connection failed:', error);
            this.ui.status.textContent = 'Connection failed - click Connect to retry';
            this.ui.connectSignalingBtn.disabled = false;
            this.ui.connectSignalingBtn.textContent = 'Retry Connection';
        }
    }
    
    onDHTConnected() {
        if (this.dht && this.dht.nodeId) {
            this.ui.peerId.textContent = this.dht.nodeId.substring(0, 8) + '...';
            this.ui.status.textContent = 'Connected';
            this.gameState = 'connected';
            this.enableMatchmaking();
            this.log('Connected to DHT network');
        }
    }
    
    setupChessEventListeners() {
        if (!this.dht) return;
        
        this.dht.on('peer_connected', (peerId) => {
            this.updatePeerCount();
            this.log(`Peer connected: ${peerId.substring(0, 8)}...`);
        });

        this.dht.on('peer_disconnected', (peerId) => {
            this.updatePeerCount();
            this.log(`Peer disconnected: ${peerId.substring(0, 8)}...`);
            
            // Handle opponent disconnection
            if (peerId === this.opponentId) {
                this.handleOpponentDisconnection();
            }
        });

        this.dht.on('message', (peerId, data) => {
            this.handleGameMessage(peerId, data);
        });
    }

    enableMatchmaking() {
        this.ui.findGameBtn.disabled = false;
        this.ui.createGameBtn.disabled = false;
        this.ui.chatInput.disabled = false;
        this.ui.sendChatBtn.disabled = false;
        this.updateDHTStats();
        
        // Start periodic updates
        setInterval(() => {
            this.updateDHTStats();
            this.updateTimers();
        }, 1000);
    }

    async findGame() {
        if (this.isSearching) return;

        this.isSearching = true;
        this.ui.findGameBtn.disabled = true;
        this.ui.cancelSearchBtn.disabled = false;
        this.ui.searchStatus.classList.remove('hidden');
        this.ui.gameStatus.textContent = 'Searching for opponents...';

        try {
            // Register as looking for a game
            const matchmakingData = {
                playerId: this.dht.nodeId,
                timestamp: Date.now(),
                gameType: 'chess'
            };

            await this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingData));
            
            // Look for other players
            const existingData = await this.dht.get(GAME_CONFIG.MATCHMAKING_KEY);
            if (existingData && existingData !== JSON.stringify(matchmakingData)) {
                try {
                    const otherPlayer = JSON.parse(existingData);
                    if (otherPlayer.playerId !== this.dht.nodeId) {
                        // Found a potential opponent, send invite
                        this.sendGameInvite(otherPlayer.playerId);
                    }
                } catch (e) {
                    console.warn('Invalid matchmaking data:', e);
                }
            }

            this.log('Started searching for games');

        } catch (error) {
            console.error('Failed to find game:', error);
            this.cancelSearch();
        }
    }

    cancelSearch() {
        this.isSearching = false;
        this.ui.findGameBtn.disabled = false;
        this.ui.cancelSearchBtn.disabled = true;
        this.ui.searchStatus.classList.add('hidden');
        this.ui.gameStatus.textContent = 'Ready to play';
        
        // Remove from matchmaking
        if (this.dht) {
            this.dht.put(GAME_CONFIG.MATCHMAKING_KEY, '').catch(console.error);
        }
        
        this.log('Cancelled game search');
    }

    createPrivateGame() {
        // This could be extended to create lobby codes or private invites
        this.log('Private game creation - feature coming soon!');
    }

    sendGameInvite(opponentId) {
        const invite = {
            type: MESSAGE_TYPES.GAME_INVITE,
            gameId: generateRandomId(),
            from: this.dht.nodeId,
            timestamp: Date.now()
        };

        this.dht.sendMessage(opponentId, invite);
        this.log(`Sent game invite to ${opponentId.substring(0, 8)}...`);
    }

    handleGameMessage(peerId, data) {
        this.log(`Received message from ${peerId.substring(0, 8)}...: ${data.type}`);

        switch (data.type) {
            case MESSAGE_TYPES.GAME_INVITE:
                this.handleGameInvite(peerId, data);
                break;
            case MESSAGE_TYPES.GAME_ACCEPT:
                this.handleGameAccept(peerId, data);
                break;
            case MESSAGE_TYPES.GAME_DECLINE:
                this.handleGameDecline(peerId, data);
                break;
            case MESSAGE_TYPES.GAME_START:
                this.handleGameStart(peerId, data);
                break;
            case MESSAGE_TYPES.MOVE:
                this.handleMove(peerId, data);
                break;
            case MESSAGE_TYPES.CHAT:
                this.handleChat(peerId, data);
                break;
            case MESSAGE_TYPES.RESIGN:
                this.handleResign(peerId, data);
                break;
            case MESSAGE_TYPES.DRAW_OFFER:
                this.handleDrawOffer(peerId, data);
                break;
            case MESSAGE_TYPES.DRAW_ACCEPT:
                this.handleDrawAccept(peerId, data);
                break;
            case MESSAGE_TYPES.REMATCH:
                this.handleRematchOffer(peerId, data);
                break;
            default:
                console.warn('Unknown message type:', data.type);
        }
    }

    handleGameInvite(peerId, data) {
        this.gameInvites.set(peerId, data);
        this.showGameInvite(peerId, data);
    }

    showGameInvite(peerId, data) {
        this.ui.inviterName.textContent = peerId.substring(0, 8) + '...';
        this.ui.inviteModal.classList.remove('hidden');
        this.currentInvite = { peerId, data };
    }

    acceptInvite() {
        if (!this.currentInvite) return;

        const { peerId, data } = this.currentInvite;
        
        // Send acceptance
        this.dht.sendMessage(peerId, {
            type: MESSAGE_TYPES.GAME_ACCEPT,
            gameId: data.gameId
        });

        // Start game as black player
        this.startGame(data.gameId, peerId, COLORS.BLACK);
        
        this.ui.inviteModal.classList.add('hidden');
        this.currentInvite = null;
        this.cancelSearch();
    }

    declineInvite() {
        if (!this.currentInvite) return;

        const { peerId, data } = this.currentInvite;
        
        this.dht.sendMessage(peerId, {
            type: MESSAGE_TYPES.GAME_DECLINE,
            gameId: data.gameId
        });

        this.ui.inviteModal.classList.add('hidden');
        this.currentInvite = null;
    }

    handleGameAccept(peerId, data) {
        // Start game as white player
        this.startGame(data.gameId, peerId, COLORS.WHITE);
        this.cancelSearch();
    }

    handleGameDecline(peerId, data) {
        this.log(`Game invite declined by ${peerId.substring(0, 8)}...`);
        // Continue searching for other opponents
    }

    startGame(gameId, opponentId, playerColor) {
        this.gameId = gameId;
        this.opponentId = opponentId;
        this.playerColor = playerColor;
        this.gameState = 'playing';
        this.engine.reset();
        this.engine.startGame();
        
        // Reset timers
        this.timeLeft = { 
            white: GAME_CONFIG.TIME_CONTROL, 
            black: GAME_CONFIG.TIME_CONTROL 
        };
        this.lastMoveTime = Date.now();
        this.startGameTimer();

        // Update UI
        this.ui.gameStatus.textContent = `Playing vs ${opponentId.substring(0, 8)}...`;
        this.ui.whitePlayer.textContent = playerColor === COLORS.WHITE ? 'You' : 'Opponent';
        this.ui.blackPlayer.textContent = playerColor === COLORS.BLACK ? 'You' : 'Opponent';
        this.ui.resignBtn.disabled = false;
        this.ui.drawBtn.disabled = false;

        // Send game start confirmation
        this.dht.sendMessage(opponentId, {
            type: MESSAGE_TYPES.GAME_START,
            gameId: gameId,
            playerColor: playerColor === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE
        });

        this.updateBoard();
        this.log(`Game started! You are playing as ${playerColor}`);
    }

    handleGameStart(peerId, data) {
        // Game start confirmation received
        this.log('Game start confirmed by opponent');
    }

    startGameTimer() {
        if (this.gameTimer) {
            clearInterval(this.gameTimer);
        }

        this.gameTimer = setInterval(() => {
            if (this.engine.gameState === GAME_STATES.ACTIVE) {
                const currentPlayer = this.engine.currentPlayer;
                const timeSinceLastMove = Date.now() - this.lastMoveTime;
                this.timeLeft[currentPlayer] -= 1000;

                if (this.timeLeft[currentPlayer] <= 0) {
                    this.timeLeft[currentPlayer] = 0;
                    this.endGame(`Time out - ${currentPlayer === COLORS.WHITE ? 'Black' : 'White'} wins!`);
                }
            }
        }, 1000);
    }

    updateTimers() {
        if (this.gameState === 'playing') {
            this.ui.whiteTime.textContent = this.formatTime(this.timeLeft.white);
            this.ui.blackTime.textContent = this.formatTime(this.timeLeft.black);
        }
    }

    formatTime(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    createChessBoard() {
        this.ui.chessBoard.innerHTML = '';
        
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const square = document.createElement('div');
                square.className = `chess-square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.row = row;
                square.dataset.col = col;
                
                square.addEventListener('click', () => this.handleSquareClick(row, col));
                
                this.ui.chessBoard.appendChild(square);
            }
        }
    }

    updateBoard() {
        const squares = this.ui.chessBoard.children;
        
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const square = squares[row * 8 + col];
                const piece = this.engine.getPiece(row, col);
                
                // Clear previous content and classes
                square.innerHTML = '';
                square.classList.remove('highlighted', 'selected', 'valid-move', 'capture-move');
                
                // Add piece if present
                if (piece) {
                    const pieceElement = document.createElement('span');
                    pieceElement.className = 'piece';
                    pieceElement.textContent = PIECE_SYMBOLS[piece.color][piece.type];
                    square.appendChild(pieceElement);
                }
                
                // Highlight selected square
                if (this.selectedSquare && this.selectedSquare[0] === row && this.selectedSquare[1] === col) {
                    square.classList.add('selected');
                }
                
                // Highlight valid moves
                if (this.validMoves.some(([r, c]) => r === row && c === col)) {
                    const targetPiece = this.engine.getPiece(row, col);
                    if (targetPiece) {
                        square.classList.add('capture-move');
                    } else {
                        square.classList.add('valid-move');
                    }
                }
            }
        }
    }

    handleSquareClick(row, col) {
        if (this.gameState !== 'playing' || this.engine.currentPlayer !== this.playerColor) {
            return;
        }

        const piece = this.engine.getPiece(row, col);
        
        // If clicking on own piece, select it
        if (piece && piece.color === this.playerColor) {
            this.selectSquare(row, col);
        }
        // If we have a piece selected and click on a valid move, make the move
        else if (this.selectedSquare && this.validMoves.some(([r, c]) => r === row && c === col)) {
            this.makeMove(this.selectedSquare[0], this.selectedSquare[1], row, col);
        }
        // Otherwise, clear selection
        else {
            this.clearSelection();
        }
    }

    selectSquare(row, col) {
        this.selectedSquare = [row, col];
        this.validMoves = this.engine.getValidMoves(row, col);
        this.updateBoard();
    }

    clearSelection() {
        this.selectedSquare = null;
        this.validMoves = [];
        this.updateBoard();
    }

    makeMove(fromRow, fromCol, toRow, toCol) {
        // Check for pawn promotion
        const piece = this.engine.getPiece(fromRow, fromCol);
        let promotion = null;
        
        if (piece.type === PIECES.PAWN && (toRow === 0 || toRow === 7)) {
            // For simplicity, always promote to queen
            // Could be extended to show promotion dialog
            promotion = PIECES.QUEEN;
        }

        const result = this.engine.makeMove(fromRow, fromCol, toRow, toCol, promotion);
        
        if (result.success) {
            // Send move to opponent
            this.dht.sendMessage(this.opponentId, {
                type: MESSAGE_TYPES.MOVE,
                gameId: this.gameId,
                move: {
                    from: [fromRow, fromCol],
                    to: [toRow, toCol],
                    promotion: promotion
                },
                fen: this.engine.toFEN(),
                timestamp: Date.now()
            });

            this.clearSelection();
            this.updateBoard();
            this.updateMoveHistory(result.move);
            this.lastMoveTime = Date.now();

            // Check for game end
            if (result.gameState === GAME_STATES.CHECKMATE) {
                const winner = this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White';
                this.endGame(`Checkmate! ${winner} wins!`);
            } else if (result.gameState === GAME_STATES.STALEMATE) {
                this.endGame('Stalemate! Draw!');
            } else if (result.gameState === GAME_STATES.CHECK) {
                this.ui.gameStatus.textContent = 'Check!';
            } else {
                this.ui.gameStatus.textContent = `${this.engine.currentPlayer}'s turn`;
            }

            this.log(`Move: ${this.engine.getAlgebraicNotation(result.move)}`);
        }
    }

    handleMove(peerId, data) {
        if (peerId !== this.opponentId || data.gameId !== this.gameId) {
            return;
        }

        const { move, fen } = data;
        const result = this.engine.makeMove(move.from[0], move.from[1], move.to[0], move.to[1], move.promotion);
        
        if (result.success) {
            this.updateBoard();
            this.updateMoveHistory(result.move);
            this.lastMoveTime = Date.now();

            // Check for game end
            if (result.gameState === GAME_STATES.CHECKMATE) {
                const winner = this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White';
                this.endGame(`Checkmate! ${winner} wins!`);
            } else if (result.gameState === GAME_STATES.STALEMATE) {
                this.endGame('Stalemate! Draw!');
            } else if (result.gameState === GAME_STATES.CHECK) {
                this.ui.gameStatus.textContent = 'Check!';
            } else {
                this.ui.gameStatus.textContent = `${this.engine.currentPlayer}'s turn`;
            }

            this.log(`Opponent move: ${this.engine.getAlgebraicNotation(result.move)}`);
        }
    }

    updateMoveHistory(move) {
        const moveEntry = document.createElement('div');
        moveEntry.className = 'move-entry';
        moveEntry.textContent = `${this.engine.fullmoveNumber}. ${this.engine.getAlgebraicNotation(move)}`;
        this.ui.moveHistory.appendChild(moveEntry);
        this.ui.moveHistory.scrollTop = this.ui.moveHistory.scrollHeight;
    }

    resign() {
        if (this.gameState !== 'playing') return;

        this.dht.sendMessage(this.opponentId, {
            type: MESSAGE_TYPES.RESIGN,
            gameId: this.gameId
        });

        this.endGame('You resigned. Opponent wins!');
    }

    handleResign(peerId, data) {
        if (peerId === this.opponentId) {
            this.endGame('Opponent resigned. You win!');
        }
    }

    offerDraw() {
        if (this.gameState !== 'playing') return;

        this.dht.sendMessage(this.opponentId, {
            type: MESSAGE_TYPES.DRAW_OFFER,
            gameId: this.gameId
        });

        this.log('Draw offer sent to opponent');
    }

    handleDrawOffer(peerId, data) {
        if (peerId === this.opponentId) {
            const accept = confirm('Your opponent offers a draw. Accept?');
            if (accept) {
                this.dht.sendMessage(this.opponentId, {
                    type: MESSAGE_TYPES.DRAW_ACCEPT,
                    gameId: this.gameId
                });
                this.endGame('Draw accepted!');
            } else {
                this.dht.sendMessage(this.opponentId, {
                    type: MESSAGE_TYPES.DRAW_DECLINE,
                    gameId: this.gameId
                });
            }
        }
    }

    handleDrawAccept(peerId, data) {
        if (peerId === this.opponentId) {
            this.endGame('Draw accepted!');
        }
    }

    offerRematch() {
        if (!this.opponentId) return;

        this.dht.sendMessage(this.opponentId, {
            type: MESSAGE_TYPES.REMATCH,
            gameId: generateRandomId()
        });

        this.log('Rematch offer sent');
    }

    handleRematchOffer(peerId, data) {
        if (peerId === this.opponentId) {
            const accept = confirm('Your opponent offers a rematch. Accept?');
            if (accept) {
                const newColor = this.playerColor === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE;
                this.startGame(data.gameId, peerId, newColor);
            }
        }
    }

    sendChat() {
        const message = this.ui.chatInput.value.trim();
        if (!message || !this.opponentId) return;

        this.dht.sendMessage(this.opponentId, {
            type: MESSAGE_TYPES.CHAT,
            message: message,
            timestamp: Date.now()
        });

        this.addChatMessage(message, true);
        this.ui.chatInput.value = '';
    }

    handleChat(peerId, data) {
        if (peerId === this.opponentId) {
            this.addChatMessage(data.message, false);
        }
    }

    addChatMessage(message, isOwn) {
        const messageElement = document.createElement('div');
        messageElement.className = `chat-message ${isOwn ? 'own' : 'opponent'}`;
        messageElement.innerHTML = `
            <div>${message}</div>
            <div class="chat-timestamp">${new Date().toLocaleTimeString()}</div>
        `;
        this.ui.chatMessages.appendChild(messageElement);
        this.ui.chatMessages.scrollTop = this.ui.chatMessages.scrollHeight;
    }

    endGame(message) {
        this.gameState = 'game_ended';
        this.engine.gameState = GAME_STATES.RESIGNED;
        
        if (this.gameTimer) {
            clearInterval(this.gameTimer);
            this.gameTimer = null;
        }

        this.ui.gameStatus.textContent = message;
        this.ui.resignBtn.disabled = true;
        this.ui.drawBtn.disabled = true;
        this.ui.rematchBtn.classList.remove('hidden');

        // Show game end modal
        this.ui.gameEndTitle.textContent = 'Game Over';
        this.ui.gameEndMessage.textContent = message;
        this.ui.gameEndModal.classList.remove('hidden');

        this.log(`Game ended: ${message}`);
    }

    closeGameEndModal() {
        this.ui.gameEndModal.classList.add('hidden');
    }

    handleOpponentDisconnection() {
        if (this.gameState === 'playing') {
            this.endGame('Opponent disconnected. You win!');
        }
    }

    updatePeerCount() {
        if (this.dht) {
            const peerCount = this.dht.getBucketCount ? this.dht.getBucketCount() : 0;
            this.ui.peerCount.textContent = peerCount;
        }
    }

    updateDHTStats() {
        if (!this.dht) return;

        const stats = {
            nodeId: this.dht.nodeId ? this.dht.nodeId.substring(0, 8) + '...' : 'N/A',
            peerCount: this.dht.getBucketCount ? this.dht.getBucketCount() : 0,
            storedKeys: this.dht.storage ? this.dht.storage.size : 0
        };

        this.ui.dhtStats.innerHTML = `
            <div>Node ID: ${stats.nodeId}</div>
            <div>Connected Peers: ${stats.peerCount}</div>
            <div>Stored Keys: ${stats.storedKeys}</div>
        `;
    }

    toggleDebug() {
        const debugPanel = document.querySelector('.debug-panel');
        const isCollapsed = debugPanel.classList.contains('collapsed');
        
        if (isCollapsed) {
            debugPanel.classList.remove('collapsed');
            this.ui.toggleDebugBtn.textContent = '-';
        } else {
            debugPanel.classList.add('collapsed');
            this.ui.toggleDebugBtn.textContent = '+';
        }
    }

    log(message) {
        console.log(`[Chess] ${message}`);
        
        const logElement = document.createElement('div');
        logElement.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
        this.ui.networkMessages.appendChild(logElement);
        this.ui.networkMessages.scrollTop = this.ui.networkMessages.scrollHeight;

        // Keep only last 50 messages
        while (this.ui.networkMessages.children.length > 50) {
            this.ui.networkMessages.removeChild(this.ui.networkMessages.firstChild);
        }
    }

    updateUI() {
        // Update UI state based on current game state
        const isConnected = this.gameState !== 'disconnected';
        const isPlaying = this.gameState === 'playing';
        
        this.ui.findGameBtn.disabled = !isConnected || isPlaying;
        this.ui.createGameBtn.disabled = !isConnected || isPlaying;
    }
}

// Initialize the game when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.chessGame = new ChessGame();
});

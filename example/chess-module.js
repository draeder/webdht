/**
 * Chess Module for WebDHT Browser Example
 * Integrates chess game functionality with the main DHT instance
 * 
 * This module implements a FULLY DHT-BASED chess matchmaking and gameplay system:
 * 
 * MATCHMAKING:
 * - Players wanting a game read the 'chess_matchmaking' DHT key (shared array)
 * - They add themselves to the array if not already present
 * - When exactly 2 players are in the array, they match and both remove themselves
 * - Game starts automatically with deterministic color assignment based on player IDs
 * 
 * GAMEPLAY:
 * - All moves are stored in DHT under unique move keys and in the game state
 * - Game state is continuously updated in DHT under the game ID
 * - Opponent moves are detected by polling DHT game state
 * - Game actions (resign, draw offers, rematch) stored in DHT under specific keys
 * 
 * NO PEER-TO-PEER MESSAGING:
 * - All communication happens through DHT storage and polling
 * - No direct peer connections required for chess functionality
 * - Purely distributed and decentralized approach
 */

import { ChessEngine, PIECES, COLORS, GAME_STATES, PIECE_SYMBOLS } from "./game/chess-engine.js";

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

export class ChessModule {
    constructor(dht) {
        // Prevent multiple instances
        if (window.chessModuleInstance) {
            console.warn('Chess: Multiple ChessModule instances detected - this may cause issues');
        }
        window.chessModuleInstance = this;
        
        this.dht = dht;
        this.engine = new ChessEngine();
        this.gameId = null;
        this.opponentId = null;
        this.playerColor = null;
        this.gameState = 'disconnected';
        this.selectedSquare = null;
        this.validMoves = [];
        this.isSearching = false;
        this.gameInvites = new Map();
        this.timeLeft = { white: GAME_CONFIG.TIME_CONTROL, black: GAME_CONFIG.TIME_CONTROL };
        this.gameTimer = null;
        this.lastMoveTime = null;
        this.invitePollingInterval = null;
        this.movePollingInterval = null;
        this.matchmakingInterval = null;
        this.lastProcessedMoveTime = 0;
        this.isChessTabActive = false;
        this.lastKnownOpponent = null;
        this.handshakeTimeout = null;
        
        // Gossip protocol for real-time move synchronization
        this.gossipEnabled = true;
        this.gossipMoveQueue = new Map(); // gameId -> array of pending moves
        this.processedGossipMoves = new Set(); // track processed move IDs to avoid duplicates
        this.processedGameActions = new Set(); // track processed game action IDs to avoid duplicates
        this.uiInitialized = false;
        
        // Game start handshake tracking
        this.gameStartHandshake = {
            sentConfirmation: false,
            receivedConfirmation: false,
            opponentId: null,
            gameId: null
        };
        
        // Logging spam prevention
        this.hasLoggedGetKeysError = false;
        this.hasLoggedNoGetKeys = false;
        this.lastOpponentConnectedState = null;
        
        // Prevent multiple draw offer modals
        this.pendingDrawOffer = false;

        // Check if chess tab is currently active
        this.checkInitialTabState();
        
        // Only initialize UI if chess tab is active, otherwise defer until activation
        if (this.isChessTabActive) {
            this.initializeUI();
        }
        
        this.bindDHTEvents();
        this.setupGossipListeners();
        // Don't start polling automatically - only when chess tab is active
    }

    checkInitialTabState() {
        // Check if chess tab is currently active during initialization
        const chessTab = document.querySelector('.tab[data-tab="chess"]');
        const chessContent = document.getElementById('chess-content');
        
        this.isChessTabActive = chessTab?.classList.contains('active') && 
                                chessContent?.classList.contains('active');
        
        console.log('Chess: Initial tab state check - chess tab active:', this.isChessTabActive);
    }

    initializeUI() {
        // Prevent multiple initializations
        if (this.uiInitialized) {
            console.log('Chess: UI already initialized, skipping');
            return;
        }

        console.log('Chess: Initializing UI');
        
        // Cache UI elements
        this.ui = {
            findGameBtn: document.getElementById('findGameBtn'),
            cancelSearchBtn: document.getElementById('cancelSearchBtn'),
            searchStatus: document.getElementById('searchStatus'),
            gameInvites: document.getElementById('gameInvites'),
            gamesList: document.getElementById('gamesList'),
            chessGameStatus: document.getElementById('chessGameStatus'),
            whitePlayer: document.getElementById('whitePlayer'),
            blackPlayer: document.getElementById('blackPlayer'),
            whiteTime: document.getElementById('whiteTime'),
            blackTime: document.getElementById('blackTime'),
            chessBoard: document.getElementById('chessBoard'),
            resignBtn: document.getElementById('resignBtn'),
            drawBtn: document.getElementById('drawBtn'),
            rematchBtn: document.getElementById('rematchBtn'),
            moveHistory: document.getElementById('moveHistory')
        };

        // Only create board and update state if UI elements are available
        if (this.ui.chessBoard) {
            this.createBoard();
        }
        
        this.updateGameState();
        this.updateConnectionState();
        this.uiInitialized = true;
        
        // Set up event listeners after UI elements are cached
        this.setupEventListeners();
        
        console.log('Chess: UI initialization complete');
    }

    setupEventListeners() {
        // Only set up event listeners if UI is initialized
        if (!this.ui) {
            console.log('Chess: Skipping setupEventListeners - UI not initialized');
            return;
        }
        
        // Button event listeners with debug logging
        if (this.ui.findGameBtn) {
            this.ui.findGameBtn.addEventListener('click', () => this.findGame());
            console.log('Chess: Find game button event listener attached');
        } else {
            console.warn('Chess: Find game button not found');
        }
        
        if (this.ui.cancelSearchBtn) {
            this.ui.cancelSearchBtn.addEventListener('click', () => this.cancelSearch());
            console.log('Chess: Cancel search button event listener attached');
        } else {
            console.warn('Chess: Cancel search button not found');
        }
        
        if (this.ui.resignBtn) {
            this.ui.resignBtn.addEventListener('click', () => this.resign());
            console.log('Chess: Resign button event listener attached');
        } else {
            console.warn('Chess: Resign button not found');
        }
        
        if (this.ui.drawBtn) {
            this.ui.drawBtn.addEventListener('click', () => this.offerDraw());
            console.log('Chess: Draw button event listener attached');
        } else {
            console.warn('Chess: Draw button not found');
        }
        
        if (this.ui.rematchBtn) {
            this.ui.rematchBtn.addEventListener('click', () => this.requestRematch());
            console.log('Chess: Rematch button event listener attached');
        } else {
            console.warn('Chess: Rematch button not found');
        }
    }

    bindDHTEvents() {
        if (!this.dht) return;

        // Update UI when DHT state changes
        this.dht.on('ready', () => {
            console.log('Chess: DHT ready event received');
            this.updateConnectionState();
        });

        this.dht.on('peer:connected', (peerId) => {
            console.log('Chess: Peer connected:', peerId?.substring(0, 8));
            if (peerId === this.opponentId) {
                console.log('Chess: OPPONENT CONNECTED! Can now use direct gossip messaging');
            }
            this.updateConnectionState();
        });

        this.dht.on('peer:disconnected', (peerId) => {
            console.log('Chess: Peer disconnected:', peerId?.substring(0, 8));
            if (peerId === this.opponentId) {
                console.log('Chess: OPPONENT DISCONNECTED! Will rely on DHT fallback');
            }
            this.updateConnectionState();
        });
        
        // Additional connection monitoring
        this.dht.on('peer:error', (err, peerId) => {
            // Only log peer errors if someone is actually on the chess tab to avoid spam
            if (this.isChessTabActive) {
                console.error('Chess: Peer error for', peerId ? peerId.substring(0, 8) : 'unknown', ':', err);
            }
        });
    }

    setupGossipListeners() {
        if (!this.dht) return;

        // Listen for incoming gossip messages from peers
        this.dht.on('peer:message', ({ message, peerId }) => {
            if (message.type === 'CHESS_GOSSIP') {
                this.handleGossipMessage(message, peerId);
            }
        });
    }

    updateConnectionState() {
        // For DHT-based chess, we just need the DHT instance to exist
        const isReady = !!this.dht;
        
        console.log('Chess Module - Connection State:', {
            dhtExists: !!this.dht,
            isReady: isReady,
            isSearching: this.isSearching,
            gameState: this.gameState,
            hasGameId: !!this.gameId
        });
        
        // Clean and consistent button state management
        if (this.ui && this.ui.findGameBtn && this.ui.cancelSearchBtn) {
            if (!isReady) {
                // DHT not available - show disabled find game button
                this.ui.findGameBtn.disabled = true;
                this.ui.findGameBtn.textContent = 'DHT Not Available';
                this.ui.findGameBtn.className = 'btn btn-secondary';
                this.ui.findGameBtn.style.display = 'block';
                this.ui.cancelSearchBtn.style.display = 'none';
                
            } else if (this.gameState === 'playing') {
                // Game active - hide both buttons completely
                this.ui.findGameBtn.style.display = 'none';
                this.ui.cancelSearchBtn.style.display = 'none';
                
            } else if (this.isSearching) {
                // Searching - hide find game, show cancel button only
                this.ui.findGameBtn.style.display = 'none';
                this.ui.cancelSearchBtn.disabled = false;
                this.ui.cancelSearchBtn.textContent = 'Cancel Search';
                this.ui.cancelSearchBtn.className = 'btn btn-secondary';
                this.ui.cancelSearchBtn.style.display = 'block';
                
            } else if (this.gameState === 'ended') {
                // Game ended - show prominent new game button
                this.ui.findGameBtn.disabled = false;
                this.ui.findGameBtn.textContent = 'Find New Game';
                this.ui.findGameBtn.className = 'btn btn-success';
                this.ui.findGameBtn.style.display = 'block';
                this.ui.cancelSearchBtn.style.display = 'none';
                
            } else {
                // Default - ready to find game
                this.ui.findGameBtn.disabled = false;
                this.ui.findGameBtn.textContent = 'Find Game';
                this.ui.findGameBtn.className = 'btn btn-primary';
                this.ui.findGameBtn.style.display = 'block';
                this.ui.cancelSearchBtn.style.display = 'none';
            }
        }
        
        // Clean search status display
        if (this.ui && this.ui.searchStatus) {
            if (this.gameState === 'playing') {
                this.ui.searchStatus.style.display = 'none';
            } else if (this.isSearching) {
                this.ui.searchStatus.style.display = 'block';
                this.ui.searchStatus.textContent = 'Looking for an opponent...';
                this.ui.searchStatus.className = 'search-status searching';
            } else if (this.gameState === 'ended') {
                this.ui.searchStatus.style.display = 'block';
                this.ui.searchStatus.textContent = 'Game ended. Ready for a new game!';
                this.ui.searchStatus.className = 'search-status ready';
            } else {
                this.ui.searchStatus.style.display = 'none';
            }
        }
        
        // Clean games list display
        if (this.ui && this.ui.gamesList) {
            if (this.gameState === 'playing' && this.gameId && this.opponentId) {
                this.ui.gamesList.innerHTML = `
                    <div class="active-game">
                        <h5>🎮 Active Game</h5>
                        <p><strong>Opponent:</strong> ${this.opponentId.substring(0, 8)}...</p>
                        <p><strong>Playing as:</strong> ${this.playerColor === 'white' ? '⚪ White' : '⚫ Black'}</p>
                    </div>
                `;
            } else if (this.isSearching) {
                this.ui.gamesList.innerHTML = `
                    <div class="searching-status">
                        <p>🔍 Looking for an opponent...</p>
                        <small>This may take a few seconds</small>
                    </div>
                `;
            } else {
                this.ui.gamesList.innerHTML = `
                    <div class="no-games">
                        <p>No active games</p>
                    </div>
                `;
            }
        }
        
        // Clean game action buttons
        if (this.ui) {
            const isPlaying = this.gameState === 'playing';
            
            if (this.ui.resignBtn) {
                this.ui.resignBtn.style.display = isPlaying ? 'inline-block' : 'none';
                this.ui.resignBtn.disabled = false;
                this.ui.resignBtn.className = 'btn btn-danger';
                this.ui.resignBtn.textContent = 'Resign';
            }
            
            if (this.ui.drawBtn) {
                this.ui.drawBtn.style.display = isPlaying ? 'inline-block' : 'none';
                this.ui.drawBtn.disabled = this.pendingDrawOffer;
                if (this.pendingDrawOffer) {
                    this.ui.drawBtn.className = 'btn btn-secondary';
                    this.ui.drawBtn.textContent = 'Draw Pending...';
                } else {
                    this.ui.drawBtn.className = 'btn btn-info';
                    this.ui.drawBtn.textContent = 'Offer Draw';
                }
            }
            
            if (this.ui.rematchBtn) {
                const showRematch = this.gameState === 'ended' && this.opponentId;
                this.ui.rematchBtn.style.display = showRematch ? 'inline-block' : 'none';
                this.ui.rematchBtn.disabled = false;
                this.ui.rematchBtn.className = 'btn btn-primary';
                this.ui.rematchBtn.textContent = 'Request Rematch';
            }
        }
    }

    createBoard() {
        if (!this.ui.chessBoard) return;

        this.ui.chessBoard.innerHTML = '';
        
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const square = document.createElement('div');
                square.className = `chess-square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
                square.dataset.row = row; // Display coordinates
                square.dataset.col = col;
                
                square.addEventListener('click', (e) => {
                    this.handleSquareClick(row, col); // Pass display coordinates
                });

                this.ui.chessBoard.appendChild(square);
            }
        }

        this.updateBoard();
    }

    updateBoard() {
        console.log('Chess: updateBoard called');
        
        if (!this.ui || !this.ui.chessBoard) {
            console.log('Chess: Cannot update board - no UI or chessBoard element');
            // Try to find the chess board element directly
            const chessBoardElement = document.getElementById('chessBoard');
            if (chessBoardElement) {
                console.log('Chess: Found chess board element, updating UI cache');
                this.ui = this.ui || {};
                this.ui.chessBoard = chessBoardElement;
            } else {
                console.log('Chess: Chess board element not found in DOM');
                return;
            }
        }

        const squares = this.ui.chessBoard.querySelectorAll('.chess-square');
        console.log('Chess: Found', squares.length, 'squares on board');
        
        if (squares.length === 0) {
            console.log('Chess: No squares found, board may not be created yet');
            return;
        }
        
        // Determine if we need to flip the board (black player sees black pieces at bottom)
        const isFlipped = this.playerColor === COLORS.BLACK;
        console.log('Chess: Board flipped:', isFlipped, 'playerColor:', this.playerColor);
        
        squares.forEach((square, index) => {
            const row = Math.floor(index / 8);
            const col = index % 8;
            
            // Get the actual board position (accounting for flip)
            const boardRow = isFlipped ? 7 - row : row;
            const boardCol = isFlipped ? 7 - col : col;
            const piece = this.engine.board[boardRow][boardCol];
            
            // Clear previous states
            square.classList.remove('selected', 'valid-move', 'last-move', 'in-check');
            
            // Add piece or clear
            if (piece) {
                square.textContent = PIECE_SYMBOLS[piece.color][piece.type];
            } else {
                square.textContent = '';
            }
            
            // Highlight selected square
            if (this.selectedSquare && this.selectedSquare.row === boardRow && this.selectedSquare.col === boardCol) {
                square.classList.add('selected');
            }
            
            // Highlight valid moves
            if (this.validMoves.some(move => {
                // Handle both array format [row, col] and object format {toRow, toCol}
                const moveRow = Array.isArray(move) ? move[0] : move.toRow;
                const moveCol = Array.isArray(move) ? move[1] : move.toCol;
                return moveRow === boardRow && moveCol === boardCol;
            })) {
                square.classList.add('valid-move');
            }
            
            // Highlight last move
            if (this.engine.lastMove) {
                const { fromRow, fromCol, toRow, toCol } = this.engine.lastMove;
                if ((boardRow === fromRow && boardCol === fromCol) || (boardRow === toRow && boardCol === toCol)) {
                    square.classList.add('last-move');
                }
            }
            
            // Highlight king in check
            if (this.engine.gameState === GAME_STATES.CHECK) {
                const kingPos = this.engine.kingPositions[this.engine.currentPlayer];
                if (kingPos && boardRow === kingPos[0] && boardCol === kingPos[1]) {
                    square.classList.add('in-check');
                }
            }
        });
        
        console.log('Chess: Board updated successfully');
    }

    handleSquareClick(row, col) {
        if (this.gameState !== 'playing' || this.engine.currentPlayer !== this.playerColor) {
            return;
        }

        // Convert display coordinates to board coordinates if board is flipped
        const isFlipped = this.playerColor === COLORS.BLACK;
        const boardRow = isFlipped ? 7 - row : row;
        const boardCol = isFlipped ? 7 - col : col;

        const piece = this.engine.board[boardRow][boardCol];
        
        // If clicking on a valid move square
        if (this.selectedSquare && this.validMoves.some(move => {
            // Handle both array format [row, col] and object format {toRow, toCol}
            const moveRow = Array.isArray(move) ? move[0] : move.toRow;
            const moveCol = Array.isArray(move) ? move[1] : move.toCol;
            return moveRow === boardRow && moveCol === boardCol;
        })) {
            this.makeMove(this.selectedSquare.row, this.selectedSquare.col, boardRow, boardCol);
            this.selectedSquare = null;
            this.validMoves = [];
        }
        // If clicking on own piece
        else if (piece && piece.color === this.playerColor) {
            this.selectedSquare = { row: boardRow, col: boardCol };
            this.validMoves = this.engine.getValidMoves(boardRow, boardCol);
        }
        // Clear selection
        else {
            this.selectedSquare = null;
            this.validMoves = [];
        }
        
        this.updateBoard();
    }

    makeMove(fromRow, fromCol, toRow, toCol) {
        console.log('Chess: Making move:', { fromRow, fromCol, toRow, toCol });
        
        // Debug connection state before making move
        console.log('Chess: Connection state before move:');
        this.debugConnectionState();
        
        const result = this.engine.makeMove(fromRow, fromCol, toRow, toCol);
        
        if (result && result.success) {
            console.log('Chess: Move successful:', result);
            
            // Switch timer to the next player
            this.switchPlayerTimer();
            
            // Send move via gossip protocol for real-time synchronization
            this.sendMoveViaGossip(result.move).then(success => {
                if (success) {
                    console.log('Chess: Move sent via gossip successfully');
                } else {
                    console.error('Chess: Move failed to send via gossip');
                }
            }).catch(err => {
                console.error('Chess: Error sending move via gossip:', err);
            });
            
            this.updateMoveHistory();
            this.updateGameState();
            this.updateBoard();
            
            // Store complete game state in DHT (includes full move history)
            this.storeGameState();
            
            // Check for game end
            if (this.engine.gameState === GAME_STATES.CHECKMATE) {
                this.endGame(`${this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White'} wins by checkmate!`);
            } else if (this.engine.gameState === GAME_STATES.STALEMATE) {
                this.endGame('Game ends in stalemate!');
            } else if (this.engine.gameState === GAME_STATES.DRAW) {
                this.endGame('Game ends in a draw!');
            }
        } else {
            console.log('Chess: Move failed - invalid move. Result:', result);
        }
    }

    // Gossip Protocol Methods

    async sendMoveViaGossip(move) {
        if (!this.gossipEnabled || !this.opponentId || !this.gameId) {
            console.log('Chess: Gossip disabled or no opponent for move gossip');
            return;
        }

        const moveId = `${this.gameId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const gossipMessage = {
            type: 'CHESS_GOSSIP',
            subType: 'MOVE',
            gameId: this.gameId,
            moveId: moveId,
            move: move,
            playerId: this.dht.nodeId,
            timestamp: Date.now()
        };

        console.log('Chess: Sending move via gossip to opponent:', this.opponentId.substring(0, 8));
        this.monitorPeerConnectivity();
        
        // Try to send the move with multiple strategies
        const success = await this.sendGossipMessage(gossipMessage, this.opponentId);
        
        if (!success) {
            console.error('Chess: Failed to send move via gossip - move may be lost!');
            return false;
        }
        
        console.log('Chess: Move sent successfully via gossip/DHT');
        return true;
    }

    async sendGossipMessage(message, targetPeerId) {
        if (!this.dht || !targetPeerId) {
            console.error('Chess: Cannot send gossip message - no DHT or target peer');
            return false;
        }

        // Enhanced debugging for peer connectivity
        console.log('Chess: Attempting to send gossip message to:', targetPeerId.substring(0, 8));
        console.log('Chess: DHT peers count:', this.dht.peers ? this.dht.peers.size : 'no peers');
        console.log('Chess: DHT peer IDs:', this.dht.peers ? Array.from(this.dht.peers.keys()).map(id => id.substring(0, 8)) : 'none');

        const peer = this.dht.peers.get(targetPeerId);
        console.log('Chess: Target peer found:', !!peer, 'connected:', peer?.connected);
        
        let directGossipSuccess = false;
        
        // Try direct gossip first
        if (peer && peer.connected) {
            try {
                peer.send(message);
                console.log('Chess: Gossip message sent successfully to peer:', targetPeerId.substring(0, 8));
                directGossipSuccess = true;
            } catch (err) {
                console.error('Chess: Error sending gossip message:', err);
                console.log('Chess: Fallback to DHT due to send error');
                directGossipSuccess = false;
            }
        } else {
            console.log('Chess: Target peer not connected for gossip, using DHT fallback');
        }
        
        // Always use DHT fallback for reliability, especially for important messages
        const dhtFallbackSuccess = await this.storeGossipMessageInDHT(message, targetPeerId);
        
        if (directGossipSuccess) {
            console.log('Chess: Message sent via direct gossip');
            return true;
        } else if (dhtFallbackSuccess) {
            console.log('Chess: Message sent via DHT fallback');
            return true;
        } else {
            console.error('Chess: Failed to send message via both gossip and DHT');
            return false;
        }
    }

    async storeGossipMessageInDHT(message, targetPeerId) {
        // Store gossip message in DHT for peers who aren't directly connected
        const messageKey = `gossip_${targetPeerId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        try {
            await this.dht.put(messageKey, JSON.stringify(message));
            console.log('Chess: Stored gossip message in DHT as fallback:', messageKey);
            return true;
        } catch (err) {
            console.error('Chess: Error storing gossip message in DHT:', err);
            return false;
        }
    }

    handleGossipMessage(message, peerId) {
        console.log('Chess: Received gossip message from:', peerId.substring(0, 8), 'type:', message.subType);

        if (message.subType === 'MOVE') {
            this.handleGossipMove(message, peerId);
        } else if (message.subType === 'GAME_ACTION') {
            this.handleGossipGameAction(message, peerId);
        } else if (message.subType === 'GAME_START_CONFIRM') {
            this.handleGameStartConfirmation(message, peerId);
        }
    }

    handleGossipMove(message, peerId) {
        console.log('Chess: Handling gossip move from:', peerId.substring(0, 8), 'moveId:', message.moveId);
        
        // Validate this is for our current game
        if (message.gameId !== this.gameId) {
            console.log('Chess: Ignoring move - wrong game ID. Expected:', this.gameId, 'Got:', message.gameId);
            return;
        }
        
        // Validate this is from our opponent
        if (peerId !== this.opponentId) {
            console.log('Chess: Ignoring move - wrong opponent. Expected:', this.opponentId?.substring(0, 8), 'Got:', peerId.substring(0, 8));
            return;
        }
        
        // Check for duplicate moves
        if (this.processedGossipMoves.has(message.moveId)) {
            console.log('Chess: Ignoring duplicate move:', message.moveId);
            return;
        }
        
        // Mark this move as processed
        this.processedGossipMoves.add(message.moveId);
        
        // Apply the move
        try {
            const move = message.move;
            console.log('Chess: Applying opponent move via gossip:', move);
            
            // Force UI update if not initialized (in case chess tab wasn't active)
            if (!this.uiInitialized) {
                this.initializeUI();
            }
            
            // Extract move coordinates from the move object
            let fromRow, fromCol, toRow, toCol;
            
            if (Array.isArray(move.from) && Array.isArray(move.to)) {
                // Handle array format [row, col]
                [fromRow, fromCol] = move.from;
                [toRow, toCol] = move.to;
            } else if (typeof move.fromRow !== 'undefined') {
                // Handle object format with individual properties
                fromRow = move.fromRow;
                fromCol = move.fromCol;
                toRow = move.toRow;
                toCol = move.toCol;
            } else {
                console.error('Chess: Invalid move format in gossip message:', move);
                return;
            }
            
            // Apply the move to the engine
            const result = this.engine.makeMove(fromRow, fromCol, toRow, toCol);
            
            if (result && result.success) {
                console.log('Chess: Opponent move applied successfully via gossip');
                
                // Switch timer to the current player (us)
                this.switchPlayerTimer();
                
                // Update UI
                this.updateMoveHistory();
                this.updateGameState();
                this.updateBoard();
                
                // Store updated game state
                this.storeGameState();
                
                // Check for game end
                if (this.engine.gameState === GAME_STATES.CHECKMATE) {
                    this.endGame(`${this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White'} wins by checkmate!`);
                } else if (this.engine.gameState === GAME_STATES.STALEMATE) {
                    this.endGame('Game ends in stalemate!');
                } else if (this.engine.gameState === GAME_STATES.DRAW) {
                    this.endGame('Game ends in a draw!');
                }
            } else {
                console.error('Chess: Failed to apply opponent move via gossip:', result);
            }
            
        } catch (err) {
            console.error('Chess: Error processing gossip move:', err);
        }
    }

    async handleGossipGameAction(message, peerId) {
        console.log('Chess: Handling gossip game action from:', peerId.substring(0, 8), 'action:', message.action);
        
        // Validate this is for our current game
        if (message.gameId !== this.gameId) {
            console.log('Chess: Ignoring game action - wrong game ID');
            return;
        }
        
        // Validate this is from our opponent
        if (peerId !== this.opponentId) {
            console.log('Chess: Ignoring game action - wrong opponent');
            return;
        }
        
        // Check for duplicate game actions using unique action ID
        const actionId = message.actionId || `${message.action}_${message.timestamp}_${peerId}`;
        if (this.processedGameActions.has(actionId)) {
            console.log('Chess: Ignoring duplicate game action:', message.action, 'actionId:', actionId);
            return;
        }
        
        // Mark this action as processed
        this.processedGameActions.add(actionId);
        
        // Handle different game actions
        switch (message.action) {
            case 'resign':
                console.log('Chess: Opponent resigned');
                this.endGame('Opponent resigned - You win!');
                break;
                
            case 'draw_offer':
                console.log('Chess: Opponent offered a draw');
                const acceptDraw = await this.showModal(
                    'Draw Offer',
                    'Your opponent is offering a draw. Do you accept?',
                    'Accept',
                    'Decline'
                );
                if (acceptDraw) {
                    this.endGame('Game ended in a draw by agreement');
                    // Send draw acceptance back
                    this.sendGameAction('draw_accept');
                } else {
                    // Send decline message to opponent
                    this.sendGameAction('draw_decline');
                    if (this.ui && this.ui.chessGameStatus) {
                        this.ui.chessGameStatus.textContent = 'Draw offer declined - game continues';
                    }
                }
                break;
                
            case 'draw_accept':
                console.log('Chess: Opponent accepted draw offer');
                // Reset pending draw offer flag
                this.pendingDrawOffer = false;
                this.endGame('Game ended in a draw by agreement');
                break;
                
            case 'draw_decline':
                console.log('Chess: Opponent declined draw offer');
                // Reset pending draw offer flag for the person who made the offer
                this.pendingDrawOffer = false;
                if (this.ui && this.ui.chessGameStatus) {
                    this.ui.chessGameStatus.textContent = 'Draw offer declined by opponent - game continues';
                }
                break;
                
            case 'rematch_request':
                console.log('Chess: Opponent requested a rematch');
                const acceptRematch = await this.showModal(
                    'Rematch Request',
                    'Your opponent wants a rematch. Do you accept?',
                    'Accept',
                    'Decline'
                );
                if (acceptRematch) {
                    // Start a new game
                    this.findGame();
                }
                break;
                
            default:
                console.log('Chess: Unknown game action:', message.action);
        }
    }

    async sendGameStartConfirmation(opponentId, gameId) {
        console.log('Chess: Sending game start confirmation to:', opponentId.substring(0, 8), 'for game:', gameId);
        
        const confirmationMessage = {
            type: 'CHESS_GOSSIP',
            subType: 'GAME_START_CONFIRM',
            gameId: gameId,
            senderId: this.dht.nodeId,
            timestamp: Date.now(),
            confirmationId: `confirm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        return await this.sendGossipMessage(confirmationMessage, opponentId);
    }

    async sendGameAction(action) {
        console.log('Chess: Sending game action:', action);
        
        if (!this.opponentId || !this.gameId) {
            console.error('Chess: Cannot send game action - no active game');
            return false;
        }
        
        const actionMessage = {
            type: 'CHESS_GOSSIP',
            subType: 'GAME_ACTION',
            gameId: this.gameId,
            action: action,
            senderId: this.dht.nodeId,
            timestamp: Date.now(),
            actionId: `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        return await this.sendGossipMessage(actionMessage, this.opponentId);
    }

    handleGameStartConfirmation(message, peerId) {
        console.log('Chess: Received game start confirmation from:', peerId.substring(0, 8), 'for game:', message.gameId);
        
        // Clear handshake timeout since we received a confirmation
        if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
            console.log('Chess: Cleared handshake timeout - received confirmation');
        }
        
        // If we don't have a game started yet, this confirmation is starting the game
        if (this.gameState !== 'playing') {
            console.log('Chess: Starting game in response to handshake confirmation');
            
            // Determine our game setup from the confirmation
            const opponentId = peerId;
            const gameId = message.gameId;
            
            // Determine colors (must match the initiator's logic)
            const playerIds = [this.dht.nodeId, opponentId].sort();
            const amIWhite = playerIds[0] === this.dht.nodeId;
            const myColor = amIWhite ? COLORS.WHITE : COLORS.BLACK;
            
            // Stop polling and start the game
            this.isSearching = false;
            this.gameState = 'playing';
            if (this.matchmakingInterval) {
                clearInterval(this.matchmakingInterval);
                this.matchmakingInterval = null;
            }
            
            // Set up handshake tracking
            this.gameStartHandshake.opponentId = opponentId;
            this.gameStartHandshake.gameId = gameId;
            this.gameStartHandshake.receivedConfirmation = true;
            
            // Start the game
            this.startGame(gameId, opponentId, myColor);
            
            // Send confirmation back (important for mutual confirmation)
            this.sendGameStartConfirmation(opponentId, gameId);
            
            // Start move polling for fallback
            this.startReducedMovePolling();
            
            return;
        }
        
        // For existing games, validate that this confirmation is for our current game
        if (!this.gameStartHandshake || message.gameId !== this.gameStartHandshake.gameId) {
            console.log('Chess: Ignoring game start confirmation - no active handshake or wrong game ID');
            return;
        }

        // Validate that this confirmation is from our expected opponent
        if (peerId !== this.gameStartHandshake.opponentId) {
            console.log('Chess: Ignoring game start confirmation - wrong sender');
            return;
        }

        // Mark that we received confirmation
        this.gameStartHandshake.receivedConfirmation = true;
        console.log('Chess: Game start confirmation received and processed');

        // Start move polling for fallback if not already started
        if (this.gameState === 'playing' && !this.movePollingInterval) {
            this.startReducedMovePolling();
        }

        // Update connection state
        this.updateConnectionState();
    }

    /**
     * Comprehensive debugging method to show current connection and game state
     */
    debugConnectionState() {
        console.log('=== CHESS MODULE DEBUG STATE ===');
        console.log('Game State:', {
            gameState: this.gameState,
            gameId: this.gameId,
            opponentId: this.opponentId?.substring(0, 8),
            playerColor: this.playerColor,
            isSearching: this.isSearching,
            gossipEnabled: this.gossipEnabled
        });
        
        console.log('DHT State:', {
            dhtExists: !!this.dht,
            nodeId: this.dht?.nodeId?.substring(0, 8),
            totalPeers: this.dht?.peers?.size || 0,
            peers: this.dht?.peers ? Array.from(this.dht.peers.entries()).map(([id, peer]) => ({
                id: id.substring(0, 8),
                connected: peer.connected,
                readyState: peer.readyState
            })) : []
        });
        
        console.log('Handshake State:', this.gameStartHandshake);
        
        console.log('UI State:', {
            uiInitialized: this.uiInitialized,
            isChessTabActive: this.isChessTabActive,
            hasChessBoard: !!this.ui?.chessBoard,
            hasMoveHistory: !!this.ui?.moveHistory
        });
        
        console.log('Engine State:', {
            engineExists: !!this.engine,
            currentPlayer: this.engine?.currentPlayer,
            moveCount: this.engine?.moveHistory?.length || 0,
            gameState: this.engine?.gameState
        });
        
        if (this.opponentId) {
            this.monitorPeerConnectivity();
        }
        
        console.log('=== END DEBUG STATE ===');
    }

    async findGame() {
        if (this.isSearching || this.gameState === 'playing') {
            console.log('Chess: Already searching or playing');
            return;
        }

        // Reset state if it's 'ended' to allow new search - FIX: Use comprehensive reset
        if (this.gameState === 'ended') {
            console.log('Chess: Resetting ended game state to allow new search');
            this.resetGameState();
        }

        console.log('Chess: Starting robust DHT matchmaking');
        this.isSearching = true;
        this.gameState = 'searching';
        
        // Update UI
        this.updateConnectionState();
        if (this.ui && this.ui.searchStatus) {
            this.ui.searchStatus.style.display = 'block';
        }

        try {
            // Use multiple attempts and longer delays for better reliability
            let matchmakingState = await this.getMatchmakingStateWithRetry();
            
            // Check if we can pair with someone searching - NO TIME LIMITS!
            const searchingPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                peerId !== this.dht.nodeId && 
                data && data.state === 'searching'
            );

            console.log('Chess: Found searching peers (no time limits):', searchingPeers.length, searchingPeers.map(([id, data]) => ({
                id: id.substring(0, 8),
                age: data.timestamp ? (Date.now() - data.timestamp) / 1000 : 'no timestamp',
                state: data.state
            })));

            if (searchingPeers.length === 0) {
                // No one searching - add ourselves with "searching" state (Peer 1 scenario)
                console.log('Chess: No one searching, adding ourselves as Peer 1');
                matchmakingState[this.dht.nodeId] = {
                    state: 'searching',
                    timestamp: Date.now(),
                    nodeId: this.dht.nodeId // Include nodeId for validation
                };
                
                await this.updateMatchmakingStateWithRetry(matchmakingState);
                
                // Start polling to check for other players
                this.startSimpleMatchmakingPolling();
                
            } else {
                // Someone is searching - add ourselves and let Peer 1 detect us (Peer 2 scenario)
                console.log('Chess: Found searching peer, adding ourselves as Peer 2');
                matchmakingState[this.dht.nodeId] = {
                    state: 'searching',
                    timestamp: Date.now(),
                    nodeId: this.dht.nodeId // Include nodeId for validation
                };
                
                await this.updateMatchmakingStateWithRetry(matchmakingState);
                
                // Start polling to see if Peer 1 matches us
                this.startSimpleMatchmakingPolling();
            }

        } catch (err) {
            console.error('Chess: Error during matchmaking:', err);
            this.isSearching = false;
            this.gameState = 'disconnected';
            this.updateConnectionState();
            
            if (this.ui && this.ui.searchStatus) {
                this.ui.searchStatus.style.display = 'none';
            }
        }
    }

    async storeGameState() {
        if (!this.gameId) return;
        
        const gameState = {
            gameId: this.gameId,
            players: {
                white: this.playerColor === COLORS.WHITE ? this.dht.nodeId : this.opponentId,
                black: this.playerColor === COLORS.BLACK ? this.dht.nodeId : this.opponentId
            },
            currentPlayer: this.engine.currentPlayer,
            board: this.engine.board,
            moveHistory: this.engine.moveHistory,
            gameState: this.engine.gameState,
            timestamp: Date.now()
        };

        try {
            console.log('Chess: Storing game state in DHT');
            await this.dht.put(this.gameId, JSON.stringify(gameState));
            console.log('Chess: Game state stored successfully');
        } catch (err) {
            console.error('Chess: Error storing game state:', err);
        }
    }

    async checkForNewMoves() {
        // Fallback method to check DHT for game state updates when gossip is unavailable
        // Only log if opponent is not connected
        if (!this.isOpponentConnected()) {
            console.log('Chess: Checking DHT for game state updates (fallback)');
        }
        
        // Check for updated game state in DHT
        if (this.gameId) {
            try {
                const gameStateData = await this.dht.get(this.gameId);
                if (gameStateData) {
                    const gameState = JSON.parse(gameStateData);
                    
                    // Check if the game state has more moves than we currently have
                    if (gameState.moveHistory && gameState.moveHistory.length > this.engine.moveHistory.length) {
                        console.log('Chess: Found updated game state in DHT with', gameState.moveHistory.length, 'moves vs our', this.engine.moveHistory.length);
                        
                        // Synchronize the entire game state from DHT
                        // This is safer than trying to apply individual moves
                        if (gameState.board && gameState.currentPlayer) {
                            console.log('Chess: Synchronizing complete game state from DHT');
                            
                            // Update engine state
                            this.engine.board = gameState.board;
                            this.engine.currentPlayer = gameState.currentPlayer;
                            this.engine.moveHistory = gameState.moveHistory || [];
                            this.engine.gameState = gameState.gameState || 'playing';
                            
                            // Update UI
                            this.updateMoveHistory();
                            this.updateGameState();
                            this.updateBoard();
                            this.switchPlayerTimer();
                            
                            console.log('Chess: Game state synchronized from DHT successfully');
                        } else {
                            console.warn('Chess: DHT game state missing required fields, skipping sync');
                        }
                    }
                }
            } catch (err) {
                console.error('Chess: Error checking game state in DHT:', err);
            }
        }
        
        // Also check for stored gossip messages
        await this.checkForStoredGossipMessages();
    }

    async checkForGameActions() {
        // Fallback method to check DHT for game actions when gossip is unavailable
        // Only log if opponent is not connected
        if (!this.isOpponentConnected()) {
            console.log('Chess: Checking DHT for game actions (fallback)');
        }
    }
    
    async checkForStoredGossipMessages() {
        if (!this.dht || !this.dht.nodeId) {
            return;
        }

        try {
            // Look for messages stored for us in DHT
            // Only log if opponent is not connected (to reduce spam)
            if (!this.isOpponentConnected()) {
                console.log('Chess: Checking DHT for stored gossip messages...');
            }
            
            // Get all keys that might contain messages for us
            const messagePrefix = `gossip_${this.dht.nodeId}`;
            
            let keys = [];
            
            // Check if DHT has a getKeys method, otherwise we'll need to track keys differently
            if (typeof this.dht.getKeys === 'function') {
                try {
                    keys = await this.dht.getKeys();
                } catch (err) {
                    // Only log first time to avoid spam
                    if (!this.hasLoggedGetKeysError) {
                        console.log('Chess: getKeys method failed, will skip stored message check:', err);
                        this.hasLoggedGetKeysError = true;
                    }
                    return;
                }
            } else {
                // If no getKeys method, we can't efficiently check for stored messages
                // This is a limitation of the current DHT implementation
                if (!this.hasLoggedNoGetKeys) {
                    console.log('Chess: DHT does not support getKeys, skipping stored message check');
                    this.hasLoggedNoGetKeys = true;
                }
                return;
            }
            
            if (!keys || !Array.isArray(keys)) {
                console.log('Chess: No keys found in DHT for gossip message check');
                return;
            }
            
            const ourMessageKeys = keys.filter(key => key.originalKey && key.originalKey.startsWith(messagePrefix));
            console.log('Chess: Found', ourMessageKeys.length, 'potential gossip messages in DHT');
            
            for (const messageKey of ourMessageKeys) {
                try {
                    const messageData = await this.dht.get(messageKey.originalKey);
                    if (messageData) {
                        const message = JSON.parse(messageData);
                        console.log('Chess: Processing stored gossip message:', message.subType);
                        
                        // Process the message as if it came via direct gossip
                        // Use senderId if playerId is not available
                        const senderId = message.playerId || message.senderId;
                        if (senderId) {
                            this.handleGossipMessage(message, senderId);
                        } else {
                            console.warn('Chess: Stored gossip message has no valid sender ID, skipping');
                        }
                        
                        // Remove the processed message from DHT (if delete method exists)
                        if (typeof this.dht.delete === 'function') {
                            await this.dht.delete(messageKey.originalKey);
                            console.log('Chess: Removed processed gossip message from DHT:', messageKey.originalKey);
                        } else {
                            console.log('Chess: DHT delete method not available, message will remain in DHT');
                        }
                    }
                } catch (err) {
                    console.error('Chess: Error processing stored gossip message:', err);
                    // Try to remove malformed message only if delete method exists
                    if (typeof this.dht.delete === 'function') {
                        try {
                            await this.dht.delete(messageKey.originalKey);
                        } catch (deleteErr) {
                            console.error('Chess: Error removing malformed message:', deleteErr);
                        }
                    }
                }
            }
            
        } catch (err) {
            console.error('Chess: Error checking for stored gossip messages:', err);
        }
        
        // Also handle handshake retry logic
        if (this.gameState === 'playing' && this.gameStartHandshake.sentConfirmation && !this.gameStartHandshake.receivedConfirmation) {
            console.log('Chess: Waiting for game start handshake confirmation...');
            
            // Try to resend the confirmation if too much time has passed
            const now = Date.now();
            if (!this.gameStartHandshake.lastSentTime || (now - this.gameStartHandshake.lastSentTime) > 5000) {
                console.log('Chess: Retrying game start confirmation send');
                const success = await this.sendGameStartConfirmation(this.gameStartHandshake.opponentId, this.gameStartHandshake.gameId);
                if (success) {
                    this.gameStartHandshake.lastSentTime = now;
                }
            }
        }
    }

    /**
     * Check if a peer exists in our DHT's peer list.
     * This is a simple way to validate that a peer is at least known to the network.
     * @param {string} peerId - The peer ID to check
     * @returns {boolean} - True if peer exists in DHT peer list, false otherwise
     */
    isPeerInDHT(peerId) {
        if (!this.dht || !this.dht.peers) {
            console.log('Chess: No DHT or peers available for peer check');
            return false;
        }
        
        const peerExists = this.dht.peers.has(peerId);
        console.log('Chess: Peer DHT check for:', peerId.substring(0, 8), 'exists:', peerExists);
        return peerExists;
    }

    /**
     * Check if opponent is currently connected via gossip
     */
    isOpponentConnected() {
        if (!this.opponentId || !this.dht || !this.dht.peers) {
            return false;
        }
        
        const opponent = this.dht.peers.get(this.opponentId);
        return opponent && opponent.connected;
    }

    // Tab activation/deactivation methods

    activate() {
        console.log('Chess: Chess module activated');
        this.isChessTabActive = true;
        
        // Initialize UI if not already done
        if (!this.uiInitialized) {
            this.initializeUI();
        }
        
        // Start polling when chess tab becomes active
        if (this.gameState === 'playing') {
            this.startReducedMovePolling();
        }
        
        // Update connection state
        this.updateConnectionState();
    }

    deactivate() {
        console.log('Chess: Chess module deactivated');
        this.isChessTabActive = false;
        
        // Keep gossip running but can stop some polling when tab is inactive
        // Still maintain reduced polling for fallback even when inactive
    }

    startReducedMovePolling() {
        // Always start polling for games - don't restrict to just when tab is active for better reliability
        console.log('Chess: Starting reduced move polling for DHT fallback');
        
        // Clear any existing polling
        if (this.movePollingInterval) {
            clearInterval(this.movePollingInterval);
        }

        // Start polling for opponent moves as fallback to gossip
        this.movePollingInterval = setInterval(async () => {
            if (this.gameState === 'playing') {
                // Monitor peer connectivity (only logs changes now)
                this.monitorPeerConnectivity();
                
                // If opponent is connected, we don't need to poll as frequently for DHT fallback
                const isConnected = this.isOpponentConnected();
                
                // Only check DHT fallback if opponent is not connected or occasionally when connected
                if (!isConnected || Math.random() < 0.1) { // 10% chance when connected
                    await this.checkForNewMoves();
                    await this.checkForGameActions();
                }
            }
        }, 3000); // 3 seconds interval - reduced from 2 seconds
        
        console.log('Chess: Move polling started with 3-second interval');
    }

    startRobustMatchmakingPolling() {
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
        }

        console.log('Chess: Starting robust matchmaking polling');
        
        this.matchmakingInterval = setInterval(async () => {
            // CRITICAL: Check if we should stop polling
            if (!this.isSearching || this.gameState !== 'searching') {
                console.log('Chess: Stopping robust matchmaking polling - no longer searching. State:', this.gameState, 'Searching:', this.isSearching);
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }
            
            // Additional safety checks
            if (this.gameId) {
                console.log('Chess: Stopping matchmaking polling - game ID already exists:', this.gameId);
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }

            if (this.gameState === 'playing') {
                console.log('Chess: Stopping matchmaking polling - already in playing state');
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }

            try {
                console.log('Chess: Polling matchmaking state with robust method...');
                let matchmakingState = await this.getMatchmakingStateWithRetry(2, 500);

                console.log('Chess: Full matchmaking state from DHT:', matchmakingState);

                // Check our own state in the matchmaking data
                const ourData = matchmakingState[this.dht.nodeId];
                console.log('Chess: Our data in matchmaking state:', ourData, 'nodeId:', this.dht.nodeId.substring(0, 8));
                
                // FIRST: Check if both players are ready to start the game (highest priority check)
                const readyPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                    peerId !== this.dht.nodeId && data && data.state === 'ready'
                );
                
                console.log('Chess: Ready peers check:', {
                    ourData: ourData,
                    ourState: ourData?.state,
                    readyPeersCount: readyPeers.length,
                    readyPeers: readyPeers.map(([id, data]) => ({ id: id.substring(0, 8), state: data.state }))
                });
                
                if (ourData && ourData.state === 'ready' && readyPeers.length > 0) {
                    // Both players are ready! But only ONE should initiate the handshake to avoid race conditions
                    const opponentId = readyPeers[0][0];
                    
                    // Determine colors and game ID (must be identical for both players)
                    const playerIds = [this.dht.nodeId, opponentId].sort();
                    const amIWhite = playerIds[0] === this.dht.nodeId;
                    const myColor = amIWhite ? COLORS.WHITE : COLORS.BLACK;
                    const gameId = `game_${Date.now()}_${playerIds[0].substring(0, 8)}_${playerIds[1].substring(0, 8)}`;
                    
                    // Only the player with the lexicographically smaller ID should initiate the handshake
                    const shouldInitiate = this.dht.nodeId < opponentId;
                    
                    console.log('Chess: Game start decision:', {
                        myId: this.dht.nodeId.substring(0, 8),
                        opponentId: opponentId.substring(0, 8),
                        shouldInitiate: shouldInitiate,
                        comparison: `${this.dht.nodeId} < ${opponentId} = ${shouldInitiate}`
                    });
                    
                    if (shouldInitiate) {
                        // Check if we're already in a game to prevent duplicate starts
                        if (this.gameState === 'playing' || this.gameId) {
                            console.log('Chess: Ignoring game initiation - already in game. State:', this.gameState, 'GameId:', this.gameId);
                            return;
                        }
                        
                        console.log('Chess: Both players ready, I am initiating gossip handshake with opponent:', opponentId.substring(0, 8));
                        console.log('Chess: Color assignment - Me:', myColor, 'Opponent:', myColor === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE);
                        
                        // Stop polling immediately and set state to prevent further polling
                        this.isSearching = false;
                        this.gameState = 'playing';
                        if (this.matchmakingInterval) {
                            clearInterval(this.matchmakingInterval);
                            this.matchmakingInterval = null;
                        }
                        
                        // Set up handshake tracking
                        this.gameStartHandshake.opponentId = opponentId;
                        this.gameStartHandshake.gameId = gameId;
                        
                        // Start the game locally first
                        this.startGame(gameId, opponentId, myColor);
                        
                        // Enhanced peer connectivity debugging
                        console.log('Chess: Pre-handshake peer check for opponent:', opponentId.substring(0, 8));
                        this.debugConnectionState();
                        
                        // Send gossip confirmation to opponent
                        const handshakeSuccess = await this.sendGameStartConfirmation(opponentId, gameId);
                        if (!handshakeSuccess) {
                            console.error('Chess: Failed to send initial game start confirmation');
                        }
                        
                        // Start move polling for fallback
                        this.startReducedMovePolling();
                    } else {
                        console.log('Chess: Both players ready, waiting for opponent to initiate handshake. Opponent:', opponentId.substring(0, 8));
                        
                        // Set up a timeout fallback in case the initiator doesn't start the game
                        if (!this.handshakeTimeout) {
                            console.log('Chess: Setting up handshake timeout fallback (15 seconds)');
                            this.handshakeTimeout = setTimeout(async () => {
                                console.warn('Chess: Handshake timeout! Opponent did not initiate game. Starting game ourselves as fallback.');
                                
                                // Stop polling and start the game ourselves
                                this.isSearching = false;
                                this.gameState = 'playing';
                                if (this.matchmakingInterval) {
                                    clearInterval(this.matchmakingInterval);
                                    this.matchmakingInterval = null;
                                }
                                
                                // Set up handshake tracking
                                this.gameStartHandshake.opponentId = opponentId;
                                this.gameStartHandshake.gameId = gameId;
                                
                                // Start the game
                                this.startGame(gameId, opponentId, myColor);
                                
                                // Send handshake
                                await this.sendGameStartConfirmation(opponentId, gameId);
                                
                                // Start move polling
                                this.startReducedMovePolling();
                            }, 15000); // Increased timeout to 15 seconds for unreliable networks
                        }
                    }
                    return; // Skip the rest of the polling logic
                }
                
                // Handle peer discovery and state transitions
                let needsUpdate = false;
                const now = Date.now();
                
                if (!ourData) {
                    // We're not in the matchmaking state - add ourselves
                    console.log('Chess: Adding ourselves to matchmaking state');
                    matchmakingState[this.dht.nodeId] = {
                        state: 'searching',
                        timestamp: now,
                        nodeId: this.dht.nodeId
                    };
                    needsUpdate = true;
                } else if (ourData.state === 'searching') {
                    // Look for other searching peers to match with
                    const searchingPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                        peerId !== this.dht.nodeId && 
                        data && data.state === 'searching'
                    );
                    
                    if (searchingPeers.length > 0) {
                        // Found someone to match with! 
                        console.log('Chess: Found peer to match with:', searchingPeers[0][0].substring(0, 8));
                        
                        // Both players set themselves to 'ready' state
                        matchmakingState[this.dht.nodeId] = {
                            ...ourData,
                            state: 'ready',
                            timestamp: now,
                            matchWith: searchingPeers[0][0]
                        };
                        needsUpdate = true;
                    } else {
                        // Update timestamp to show we're still active
                        if ((now - ourData.timestamp) > 10000) { // Update every 10 seconds
                            matchmakingState[this.dht.nodeId] = {
                                ...ourData,
                                timestamp: now
                            };
                            needsUpdate = true;
                        }
                    }
                }

                if (needsUpdate) {
                    await this.updateMatchmakingStateWithRetry({ [this.dht.nodeId]: matchmakingState[this.dht.nodeId] });
                }

            } catch (err) {
                console.error('Chess: Error during robust matchmaking polling:', err);
                // Don't stop polling on errors - network might be unreliable
            }
        }, 3000); // Increased interval to 3 seconds for better network reliability
    }

    /**
     * Enhanced matchmaking with better DHT operations for unreliable connections
     */
    async robustDHTOperation(operation, key, value = null, maxRetries = 3) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                let result;
                if (operation === 'get') {
                    result = await this.dht.get(key);
                } else if (operation === 'put') {
                    result = await this.dht.put(key, value);
                } else if (operation === 'delete') {
                    if (typeof this.dht.delete === 'function') {
                        result = await this.dht.delete(key);
                    } else {
                        console.warn('Chess: DHT delete method not available');
                        return false;
                    }
                }
                
                // Add a small delay to allow network propagation
                if (operation === 'put' && attempt < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                
                return result;
            } catch (err) {
                console.error(`Chess: DHT ${operation} failed (attempt ${attempt + 1}/${maxRetries}):`, err);
                if (attempt === maxRetries - 1) throw err;
                
                // Exponential backoff
                const delay = 1000 * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    startSimpleMatchmakingPolling() {
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
        }

        console.log('Chess: Starting simple matchmaking polling');
        
        this.matchmakingInterval = setInterval(async () => {
            // CRITICAL: Check if we should stop polling
            if (!this.isSearching || this.gameState !== 'searching') {
                console.log('Chess: Stopping simple matchmaking polling - no longer searching. State:', this.gameState, 'Searching:', this.isSearching);
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }
            
            // Additional safety checks
            if (this.gameId) {
                console.log('Chess: Stopping matchmaking polling - game ID already exists:', this.gameId);
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }

            if (this.gameState === 'playing') {
                console.log('Chess: Stopping matchmaking polling - already in playing state');
                if (this.matchmakingInterval) {
                    clearInterval(this.matchmakingInterval);
                    this.matchmakingInterval = null;
                }
                return;
            }

            try {
                console.log('Chess: Polling matchmaking state with robust operations...');
                let matchmakingData = await this.robustDHTOperation('get', GAME_CONFIG.MATCHMAKING_KEY);
                let matchmakingState = {};
                
                if (matchmakingData) {
                    try {
                        let parsedData = JSON.parse(matchmakingData);
                        console.log('Chess: Current DHT state:', parsedData);
                        
                        // Handle case where DHT returns an array instead of object
                        if (Array.isArray(parsedData)) {
                            console.log('Chess: Converting array to object format in polling');
                            matchmakingState = {};
                        } else if (typeof parsedData === 'object' && parsedData !== null) {
                            matchmakingState = parsedData;
                        } else {
                            console.warn('Chess: Unexpected matchmaking data type during polling, treating as empty');
                            matchmakingState = {};
                        }
                    } catch (err) {
                        console.warn('Chess: Invalid matchmaking data during polling');
                        return;
                    }
                }

                // Clean up stale entries first (older than 2 minutes)
                const now = Date.now();
                const cleanedState = {};
                Object.entries(matchmakingState).forEach(([peerId, data]) => {
                    if (data && data.timestamp && (now - data.timestamp) < 2 * 60 * 1000) {
                        cleanedState[peerId] = data;
                    } else if (peerId === this.dht.nodeId) {
                        // Always keep our own entry
                        cleanedState[peerId] = data;
                    } else {
                        console.log(`Chess: Cleaning up stale entry for peer: ${peerId.substring(0, 8)}`);
                    }
                });
                matchmakingState = cleanedState;

                // Check our own state in the matchmaking data
                const ourData = matchmakingState[this.dht.nodeId];
                console.log('Chess: Our data in matchmaking state:', ourData, 'nodeId:', this.dht.nodeId.substring(0, 8));
                
                // Handle our own state based on what's actually in the DHT
                let needsUpdate = false;
                
                if (!ourData) {
                    // We're not in the state - re-add ourselves
                    console.log('Chess: Re-adding ourselves to matchmaking state');
                    matchmakingState[this.dht.nodeId] = {
                        state: 'searching',
                        timestamp: now
                    };
                    needsUpdate = true;
                } else if (ourData.state === 'searching') {
                    // We're searching - check if we can match with someone
                    const searchingPeers = Object.entries(matchmakingState).filter(([peerId, data]) => 
                        peerId !== this.dht.nodeId && data && data.state === 'searching'
                    );
                    
                    if (searchingPeers.length > 0) {
                        // Found a potential opponent! 
                        const potentialOpponentId = searchingPeers[0][0];
                        console.log('Chess: Found potential opponent:', potentialOpponentId.substring(0, 8));
                        
                        // Check if this peer exists in our DHT
                        const peerExists = this.isPeerInDHT(potentialOpponentId);
                        
                        if (peerExists) {
                            // Start game immediately - simpler approach
                            console.log('Chess: Peer exists in DHT! Starting game with opponent:', potentialOpponentId.substring(0, 8));
                            
                            // Remove both players from matchmaking
                            delete matchmakingState[this.dht.nodeId];
                            delete matchmakingState[potentialOpponentId];
                            await this.robustDHTOperation('put', GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                            
                            // Determine colors and game ID
                            const playerIds = [this.dht.nodeId, potentialOpponentId].sort();
                            const amIWhite = playerIds[0] === this.dht.nodeId;
                            const myColor = amIWhite ? COLORS.WHITE : COLORS.BLACK;
                            const gameId = `game_${Date.now()}_${playerIds[0].substring(0, 8)}_${playerIds[1].substring(0, 8)}`;
                            
                            // Stop polling immediately and set state to prevent further polling
                            this.isSearching = false;
                            this.gameState = 'playing';
                            if (this.matchmakingInterval) {
                                clearInterval(this.matchmakingInterval);
                                this.matchmakingInterval = null;
                            }
                            
                            // Set up handshake tracking
                            this.gameStartHandshake.opponentId = potentialOpponentId;
                            this.gameStartHandshake.gameId = gameId;
                            
                            // Start the game locally
                            this.startGame(gameId, potentialOpponentId, myColor);
                            
                            // Send handshake confirmation
                            await this.sendGameStartConfirmation(potentialOpponentId, gameId);
                            
                            // Start move polling for fallback
                            this.startReducedMovePolling();
                            
                            return;
                        } else {
                            // Peer doesn't exist - remove stale entry
                            console.log('Chess: Peer not found in DHT peer list - removing stale entry:', potentialOpponentId.substring(0, 8));
                            delete matchmakingState[potentialOpponentId];
                            needsUpdate = true;
                        }
                    } else {
                        // Just refresh our timestamp
                        matchmakingState[this.dht.nodeId].timestamp = now;
                        needsUpdate = true;
                    }
                }

                // Update the state if needed
                if (needsUpdate) {
                    await this.robustDHTOperation('put', GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                }

            } catch (err) {
                console.error('Chess: Error during simple matchmaking polling:', err);
                // Don't stop polling on network errors - retry on next cycle
            }
        }, 4000); // Poll every 4 seconds for better reliability
    }

    async getMatchmakingStateWithRetry(maxRetries = 3, delay = 1000) {
        // Get matchmaking state from DHT with retry logic
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const data = await this.robustDHTOperation('get', GAME_CONFIG.MATCHMAKING_KEY);
                if (data) {
                    const parsed = JSON.parse(data);
                    return typeof parsed === 'object' && parsed !== null ? parsed : {};
                } else {
                    return {};
                }
            } catch (err) {
                console.error(`Chess: Failed to get matchmaking state (attempt ${attempt + 1}/${maxRetries}):`, err);
                if (attempt === maxRetries - 1) {
                    console.warn('Chess: All attempts failed, returning empty state');
                    return {};
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    async updateMatchmakingStateWithRetry(stateUpdate, maxRetries = 3, delay = 1000) {
        // Update matchmaking state in DHT with retry logic
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // Get current state
                let currentState = await this.getMatchmakingStateWithRetry(1, 0);
                
                // Apply updates
                Object.assign(currentState, stateUpdate);
                
                // Save back to DHT
                await this.robustDHTOperation('put', GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(currentState));
                
                console.log('Chess: Matchmaking state updated successfully');
                return true;
            } catch (err) {
                console.error(`Chess: Failed to update matchmaking state (attempt ${attempt + 1}/${maxRetries}):`, err);
                if (attempt === maxRetries - 1) {
                    console.error('Chess: All attempts failed to update matchmaking state');
                    return false;
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Monitor peer connectivity for debugging
     */
    monitorPeerConnectivity() {
        if (!this.opponentId || !this.dht || !this.dht.peers) {
            return;
        }

        const opponent = this.dht.peers.get(this.opponentId);
        const isConnected = opponent && opponent.connected;
        
        // Only log connectivity changes to reduce spam
        if (this.lastOpponentConnectedState !== isConnected) {
            console.log(`Chess: Opponent connectivity changed: ${isConnected ? 'connected' : 'disconnected'}`);
            this.lastOpponentConnectedState = isConnected;
        }
    }

    endGame(message) {
        console.log('Chess: Ending game -', message);
        
        // Stop the timer
        if (this.gameTimer && this.gameTimer.interval) {
            clearInterval(this.gameTimer.interval);
            this.gameTimer.interval = null;
        }
        
        // Clear all polling intervals
        if (this.movePollingInterval) {
            clearInterval(this.movePollingInterval);
            this.movePollingInterval = null;
        }
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
            this.matchmakingInterval = null;
        }
        
        // Clear handshake timeout
        if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
        }
        
        // Reset game state variables - FIX: Clear gameId and opponentId
        this.gameState = 'ended';
        this.isSearching = false;
        // Reset pending draw offer flag when game ends
        this.pendingDrawOffer = false;
        
        // Keep gameId and opponentId for a short time to allow rematch, then clear them
        setTimeout(() => {
            if (this.gameState === 'ended') {
                console.log('Chess: Clearing game session data after game end');
                this.gameId = null;
                this.opponentId = null;
                this.playerColor = null;
                this.gameState = 'disconnected';
                this.updateConnectionState();
            }
        }, 30000); // Clear after 30 seconds to allow time for rematch
        
        // Update UI with better messaging
        if (this.ui && this.ui.chessGameStatus) {
            this.ui.chessGameStatus.textContent = message;
        }
        
        // Update connection state to refresh all buttons and displays
        this.updateConnectionState();
        
        console.log('Chess: Game ended successfully');
    }

    startGame(gameId, opponentId, playerColor) {
        console.log('Chess: Starting new game', { gameId, opponentId: opponentId.substring(0, 8), playerColor });
        
        // Set game state
        this.gameId = gameId;
        this.opponentId = opponentId;
        this.playerColor = playerColor;
        this.gameState = 'playing';
        this.isSearching = false;
        
        // Initialize game tracking
        this.processedGossipMoves = new Set();
        this.processedGameActions = new Set();
        
        // Clear matchmaking polling
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
            this.matchmakingInterval = null;
        }
        
        // Initialize chess engine
        this.engine.reset();
        
               
        // Initialize timer system
        this.timeLeft = {
            white: GAME_CONFIG.TIME_CONTROL,
            black: GAME_CONFIG.TIME_CONTROL
        };
        this.gameTimer = {
            currentPlayer: COLORS.WHITE, // White always starts
            interval: null
        };
        this.lastMoveTime = Date.now();
        
        // Start the timer for the first move (White)
        this.switchPlayerTimer();
        
        // Initialize UI if not already done
        if (!this.uiInitialized) {
            this.initializeUI();
        }
        
        // Update UI state
        this.updateConnectionState();
        this.updateGameState(); // Use the proper updateGameState method
        
        if (this.ui && this.ui.searchStatus) {
            this.ui.searchStatus.style.display = 'none';
        }
        if (this.ui && this.ui.findGameBtn) {
            this.ui.findGameBtn.style.display = 'none';
        }
        
        // Update board
        this.createBoard();
        this.updateBoard();
        
        console.log('Chess: Game started successfully with timer initialized');
    }

    /**
     * Immediately reset game state to allow starting a new game
     */
    resetGameState() {
        console.log('Chess: Resetting game state for new game');
        
        // Clear all intervals
        if (this.gameTimer && this.gameTimer.interval) {
            clearInterval(this.gameTimer.interval);
            this.gameTimer.interval = null;
        }
        if (this.movePollingInterval) {
            clearInterval(this.movePollingInterval);
            this.movePollingInterval = null;
        }
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
            this.matchmakingInterval = null;
        }
        if (this.handshakeTimeout) {
            clearTimeout(this.handshakeTimeout);
            this.handshakeTimeout = null;
        }
        
        // Reset all game variables
        this.gameId = null;
        this.opponentId = null;
        this.playerColor = null;
        this.gameState = 'disconnected';
        this.isSearching = false;
        
        // Reset game tracking
        this.processedGossipMoves = new Set();
        this.processedGameActions = new Set();
        this.gameStartHandshake = {
            sentConfirmation: false,
            receivedConfirmation: false,
            opponentId: null,
            gameId: null
        };
        
        // Update UI
        this.updateConnectionState();
        
        console.log('Chess: Game state reset complete');
    }

    updateGameState() {
        // Update UI elements based on current game state
        if (!this.ui) return;
        
        // Update game status text - FIX: Use correct UI element name
        if (this.ui.chessGameStatus) {
            if (this.gameState === 'playing' && this.engine) {
                const currentPlayerText = this.engine.currentPlayer === this.playerColor ? "Your" : "Opponent's";
                let statusText = `Playing as ${this.playerColor}. ${currentPlayerText} turn.`;
                
                // Add check or checkmate status
                if (this.engine.gameState === GAME_STATES.CHECK) {
                    statusText += " (Check!)";
                } else if (this.engine.gameState === GAME_STATES.CHECKMATE) {
                    const winner = this.engine.currentPlayer === COLORS.WHITE ? 'Black' : 'White';
                    statusText = `Game Over - ${winner} wins by checkmate!`;
                } else if (this.engine.gameState === GAME_STATES.STALEMATE) {
                    statusText = "Game Over - Stalemate (Draw)";
                }
                
                this.ui.chessGameStatus.textContent = statusText;
            } else if (this.gameState === 'searching') {
                this.ui.chessGameStatus.textContent = 'Searching for opponents...';
            } else if (this.gameState === 'ended') {
                // Keep the end game message that was set
            } else {
                this.ui.chessGameStatus.textContent = 'Not connected';
            }
        }
        
        // Update timer displays if they exist - FIX: Use correct UI element names

        if (this.ui.whiteTime && this.ui.blackTime && this.timeLeft) {
            const formatTime = (ms) => {
                const minutes = Math.floor(ms / 60000);
                const seconds = Math.floor((ms % 60000) / 1000);
                return `${minutes}:${seconds.toString().padStart(2, '0')}`;
            };
            
            this.ui.whiteTime.textContent = formatTime(this.timeLeft.white || 0);
            this.ui.blackTime.textContent = formatTime(this.timeLeft.black || 0);
        }
        
        // Update player names if available
        if (this.ui.whitePlayer && this.ui.blackPlayer && this.gameState === 'playing') {
            const whitePlayerName = this.playerColor === COLORS.WHITE ? 'You' : 'Opponent';
            const blackPlayerName = this.playerColor === COLORS.BLACK ? 'You' : 'Opponent';
            this.ui.whitePlayer.textContent = whitePlayerName;
            this.ui.blackPlayer.textContent = blackPlayerName;
        }
    }

    updateMoveHistory() {
        // Update move history display
        if (!this.ui || !this.ui.moveHistory || !this.engine) return;
        
        this.ui.moveHistory.innerHTML = '';
        
        if (this.engine.moveHistory && this.engine.moveHistory.length > 0) {
            // Group moves in pairs (white move + black move)
            for (let i = 0; i < this.engine.moveHistory.length; i += 2) {
                const moveElement = document.createElement('div');
                moveElement.className = 'move-pair';
                
                const moveNumber = Math.floor(i / 2) + 1;
                let moveText = `${moveNumber}.`;
                
                // White move (always exists for each pair)
                const whiteMove = this.engine.moveHistory[i];
                try {
                    const whiteNotation = this.engine.getAlgebraicNotation(whiteMove);
                    moveText += ` ${whiteNotation}`;
                } catch (err) {
                    console.warn('Chess: Failed to generate algebraic notation for white move, falling back:', err);
                    moveText += ` ${this.getFallbackNotation(whiteMove)}`;
                }
                
                // Black move (might not exist if it's the last move and white just moved)
                const blackMove = this.engine.moveHistory[i + 1];
                if (blackMove) {
                    try {
                        const blackNotation = this.engine.getAlgebraicNotation(blackMove);
                        moveText += ` ${blackNotation}`;
                    } catch (err) {
                        console.warn('Chess: Failed to generate algebraic notation for black move, falling back:', err);
                        moveText += ` ${this.getFallbackNotation(blackMove)}`;
                    }
                }
                
                moveElement.textContent = moveText;
                this.ui.moveHistory.appendChild(moveElement);
            }
            
            // Scroll to bottom to show latest move
            this.ui.moveHistory.scrollTop = this.ui.moveHistory.scrollHeight;
        } else {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'no-moves';
            emptyMessage.textContent = 'No moves yet';
            this.ui.moveHistory.appendChild(emptyMessage);
        }
    }

    getFallbackNotation(move) {
        // Helper method to generate simple fallback notation
        let fromRow, fromCol, toRow, toCol;
        
        if (move.from && Array.isArray(move.from) && move.to && Array.isArray(move.to)) {
            [fromRow, fromCol] = move.from;
            [toRow, toCol] = move.to;
        } else {
            fromRow = move.fromRow || 0;
            fromCol = move.fromCol || 0;
            toRow = move.toRow || 0;
            toCol = move.toCol || 0;
        }
        
        const from = `${String.fromCharCode(97 + fromCol)}${8 - fromRow}`;
        const to = `${String.fromCharCode(97 + toCol)}${8 - toRow}`;
        return `${from}-${to}`;
    }

    switchPlayerTimer() {
        // Switch the game timer to the next player
        console.log('Chess: Switching player timer to:', this.engine.currentPlayer);
        
        if (this.gameState !== 'playing') {
            console.log('Chess: Not switching timer - game not playing');
            return;
        }
        
        // Initialize timer system if not already done
        if (!this.gameTimer) {
            this.gameTimer = {
                currentPlayer: this.engine.currentPlayer,
                interval: null
            };
        }
        
        // Initialize time tracking if not already done
        if (!this.timeLeft) {
            this.timeLeft = {
                white: GAME_CONFIG.TIME_CONTROL,
                black: GAME_CONFIG.TIME_CONTROL
            };
        }
        
        // Stop current timer
        if (this.gameTimer.interval) {
            clearInterval(this.gameTimer.interval);
            this.gameTimer.interval = null;
        }
        
        // Record time spent by previous player (if there was one)
        if (this.lastMoveTime && this.gameTimer.currentPlayer) {
            const timeSpent = Date.now() - this.lastMoveTime;
            this.timeLeft[this.gameTimer.currentPlayer] = Math.max(0, this.timeLeft[this.gameTimer.currentPlayer] - timeSpent);
            console.log('Chess: Time spent by', this.gameTimer.currentPlayer, ':', timeSpent, 'ms. Remaining:', this.timeLeft[this.gameTimer.currentPlayer]);
        }
        
        // Switch to current player
        this.gameTimer.currentPlayer = this.engine.currentPlayer;
        this.lastMoveTime = Date.now();
        
        // Update UI immediately
        this.updateGameState();
        
        // Start timer for current player
        this.gameTimer.interval = setInterval(() => {
            if (this.gameState !== 'playing') {
                clearInterval(this.gameTimer.interval);
                this.gameTimer.interval = null;
                return;
            }
            
            // Subtract one second from current player's time
            this.timeLeft[this.gameTimer.currentPlayer] = Math.max(0, this.timeLeft[this.gameTimer.currentPlayer] - 1000);
            
            // Update UI
            this.updateGameState();
            
            // Check for time out
            if (this.timeLeft[this.gameTimer.currentPlayer] <= 0) {
                clearInterval(this.gameTimer.interval);
                this.gameTimer.interval = null;
                const winner = this.gameTimer.currentPlayer === COLORS.WHITE ? 'Black' : 'White';
                this.endGame(`${winner} wins by timeout!`);
            }
        }, 1000);
        
        console.log('Chess: Timer started for', this.gameTimer.currentPlayer, 'with', this.timeLeft[this.gameTimer.currentPlayer], 'ms remaining');
    }

    async cancelSearch() {
        console.log('Chess: Canceling search');
        
        this.isSearching = false;
        this.gameState = 'disconnected';
        
        // Clear any polling intervals
        if (this.matchmakingInterval) {
            clearInterval(this.matchmakingInterval);
            this.matchmakingInterval = null;
        }
        
        // Remove ourselves from matchmaking state
        try {
            let matchmakingState = await this.getMatchmakingStateWithRetry(1, 100);
            if (matchmakingState && matchmakingState[this.dht.nodeId]) {
                delete matchmakingState[this.dht.nodeId];
                await this.robustDHTOperation('put', GAME_CONFIG.MATCHMAKING_KEY, JSON.stringify(matchmakingState));
                console.log('Chess: Removed from matchmaking state');
            }
        } catch (err) {
            console.error('Chess: Error removing from matchmaking state:', err);
        }
        
        // Update UI
        this.updateConnectionState();
        
        console.log('Chess: Search canceled successfully');
    }

    async resign() {
        console.log('Chess: Player resigned');
        
        if (this.gameState !== 'playing') {
            console.log('Chess: Cannot resign - not in active game');
            return;
        }
        
        // Confirm resignation with modal
        const confirmResign = await this.showModal(
            'Resign Game', 
            'Are you sure you want to resign? This will end the game.',
            'Resign',
            'Cancel'
        );
        
        if (!confirmResign) {
            console.log('Chess: Resignation cancelled by user');
            return;
        }
        
        // Send resignation to opponent
        const success = await this.sendGameAction('resign');
        
        if (success) {
            console.log('Chess: Resignation sent successfully');
        } else {
            console.error('Chess: Failed to send resignation, but ending game anyway');
        }
        
        // End the game
        this.endGame('You resigned - Opponent wins!');
    }

    async offerDraw() {
        console.log('Chess: Offering draw');
        
        if (this.gameState !== 'playing') {
            console.log('Chess: Cannot offer draw - not in active game');
            return;
        }
        
        if (this.pendingDrawOffer) {
            console.log('Chess: Draw offer already pending - ignoring additional clicks');
            return;
        }
        
        // Set flag to prevent multiple draw offers
        this.pendingDrawOffer = true;
        
        // Send draw offer to opponent
        const success = await this.sendGameAction('draw_offer');
        
        if (success) {
            console.log('Chess: Draw offer sent successfully');
            // Update UI to show draw offer sent - FIX: Use correct UI element name
            if (this.ui && this.ui.chessGameStatus) {
                this.ui.chessGameStatus.textContent = 'Draw offer sent to opponent...';
            }
        } else {
            console.error('Chess: Failed to send draw offer');
            if (this.ui && this.ui.chessGameStatus) {
                this.ui.chessGameStatus.textContent = 'Failed to send draw offer';
            }
            // Reset flag if sending failed
            this.pendingDrawOffer = false;
        }
    }

    async requestRematch() {
        console.log('Chess: Requesting rematch');
        
        if (!this.opponentId) {
            console.log('Chess: Cannot request rematch - no opponent');
            return;
        }
        
        // Send rematch request to opponent
        const success = await this.sendGameAction('rematch_request');
        
        if (success) {
            console.log('Chess: Rematch request sent successfully');
            // Update UI to show rematch request sent - FIX: Use correct UI element name
            if (this.ui && this.ui.chessGameStatus) {
                this.ui.chessGameStatus.textContent = 'Rematch request sent to opponent...';
            }
        } else {
            console.error('Chess: Failed to send rematch request');
            if (this.ui && this.ui.chessGameStatus) {
                this.ui.chessGameStatus.textContent = 'Failed to send rematch request';
            }
        }
    }

    /**
     * Create and show a modal dialog
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {string} confirmText - Text for confirm button (default: "Yes")
     * @param {string} cancelText - Text for cancel button (default: "No")
     * @returns {Promise<boolean>} - Resolves to true if confirmed, false if canceled
     */
    showModal(title, message, confirmText = "Yes", cancelText = "No") {
        return new Promise((resolve) => {
            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'chess-modal-overlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                font-family: Arial, sans-serif;
            `;

            // Create modal content
            const modal = document.createElement('div');
            modal.className = 'chess-modal';
            modal.style.cssText = `
                background: white;
                border-radius: 8px;
                padding: 24px;
                max-width: 400px;
                width: 90%;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                text-align: center;
            `;

            // Create title
            const titleEl = document.createElement('h3');
            titleEl.textContent = title;
            titleEl.style.cssText = `
                margin: 0 0 16px 0;
                color: #333;
                font-size: 18px;
                font-weight: bold;
            `;

            // Create message
            const messageEl = document.createElement('p');
            messageEl.textContent = message;
            messageEl.style.cssText = `
                margin: 0 0 24px 0;
                color: #666;
                font-size: 14px;
                line-height: 1.4;
            `;

            // Create button container
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = `
                display: flex;
                gap: 12px;
                justify-content: center;
            `;

            // Create cancel button
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = cancelText;
            cancelBtn.style.cssText = `
                padding: 10px 20px;
                border: 2px solid #ddd;
                background: white;
                color: #666;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                min-width: 80px;
            `;

            // Create confirm button
            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = confirmText;
            confirmBtn.style.cssText = `
                padding: 10px 20px;
                border: none;
                background: #007bff;
                color: white;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                min-width: 80px;
            `;

            // Add hover effects
            cancelBtn.addEventListener('mouseenter', () => {
                cancelBtn.style.background = '#f8f9fa';
            });
            cancelBtn.addEventListener('mouseleave', () => {
                cancelBtn.style.background = 'white';
            });

            confirmBtn.addEventListener('mouseenter', () => {
                confirmBtn.style.background = '#0056b3';
            });
            confirmBtn.addEventListener('mouseleave', () => {
                confirmBtn.style.background = '#007bff';
            });

            // Add event listeners
            const cleanup = () => {
                if (overlay.parentNode) {
                    overlay.parentNode.removeChild(overlay);
                }
            };

            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            });

            confirmBtn.addEventListener('click', () => {
                cleanup();
                resolve(true);
            });

            // Close on overlay click
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cleanup();
                    resolve(false);
                }
            });

            // Close on escape key
            const handleKeyDown = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    document.removeEventListener('keydown', handleKeyDown);
                    resolve(false);
                } else if (e.key === 'Enter') {
                    cleanup();
                    document.removeEventListener('keydown', handleKeyDown);
                    resolve(true);
                }
            };
            document.addEventListener('keydown', handleKeyDown);

            // Assemble modal
            buttonContainer.appendChild(cancelBtn);
            buttonContainer.appendChild(confirmBtn);
            modal.appendChild(titleEl);
            modal.appendChild(messageEl);
            modal.appendChild(buttonContainer);
            overlay.appendChild(modal);

            // Add to DOM
            document.body.appendChild(overlay);

            // Focus the confirm button
            setTimeout(() => confirmBtn.focus(), 100);
        });
    }
}
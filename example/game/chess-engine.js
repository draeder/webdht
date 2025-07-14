/**
 * Chess Engine - Game rules and board logic
 */

// Chess piece types
export const PIECES = {
    KING: 'k',
    QUEEN: 'q', 
    ROOK: 'r',
    BISHOP: 'b',
    KNIGHT: 'n',
    PAWN: 'p'
};

// Colors
export const COLORS = {
    WHITE: 'white',
    BLACK: 'black'
};

// Unicode chess pieces
export const PIECE_SYMBOLS = {
    [COLORS.WHITE]: {
        [PIECES.KING]: '♔',
        [PIECES.QUEEN]: '♕',
        [PIECES.ROOK]: '♖',
        [PIECES.BISHOP]: '♗',
        [PIECES.KNIGHT]: '♘',
        [PIECES.PAWN]: '♙'
    },
    [COLORS.BLACK]: {
        [PIECES.KING]: '♚',
        [PIECES.QUEEN]: '♛',
        [PIECES.ROOK]: '♜',
        [PIECES.BISHOP]: '♝',
        [PIECES.KNIGHT]: '♞',
        [PIECES.PAWN]: '♟'
    }
};

// Game states
export const GAME_STATES = {
    WAITING: 'waiting',
    ACTIVE: 'active',
    CHECK: 'check',
    CHECKMATE: 'checkmate',
    STALEMATE: 'stalemate',
    DRAW: 'draw',
    RESIGNED: 'resigned'
};

export class ChessEngine {
    constructor() {
        this.reset();
    }

    reset() {
        this.board = this.createInitialBoard();
        this.currentPlayer = COLORS.WHITE;
        this.gameState = GAME_STATES.WAITING;
        this.moveHistory = [];
        this.lastMove = null;
        this.capturedPieces = { [COLORS.WHITE]: [], [COLORS.BLACK]: [] };
        this.kingPositions = { [COLORS.WHITE]: [7, 4], [COLORS.BLACK]: [0, 4] };
        this.castlingRights = {
            [COLORS.WHITE]: { kingside: true, queenside: true },
            [COLORS.BLACK]: { kingside: true, queenside: true }
        };
        this.enPassantTarget = null;
        this.halfmoveClock = 0; // For 50-move rule
        this.fullmoveNumber = 1;
    }

    createInitialBoard() {
        const board = Array(8).fill(null).map(() => Array(8).fill(null));
        
        // Set up pieces
        const pieces = [PIECES.ROOK, PIECES.KNIGHT, PIECES.BISHOP, PIECES.QUEEN, 
                       PIECES.KING, PIECES.BISHOP, PIECES.KNIGHT, PIECES.ROOK];
        
        // Black pieces (top)
        for (let i = 0; i < 8; i++) {
            board[0][i] = { type: pieces[i], color: COLORS.BLACK };
            board[1][i] = { type: PIECES.PAWN, color: COLORS.BLACK };
        }
        
        // White pieces (bottom)
        for (let i = 0; i < 8; i++) {
            board[6][i] = { type: PIECES.PAWN, color: COLORS.WHITE };
            board[7][i] = { type: pieces[i], color: COLORS.WHITE };
        }
        
        return board;
    }

    startGame() {
        this.gameState = GAME_STATES.ACTIVE;
    }

    getPiece(row, col) {
        return this.board[row]?.[col] || null;
    }

    setPiece(row, col, piece) {
        if (row >= 0 && row < 8 && col >= 0 && col < 8) {
            this.board[row][col] = piece;
        }
    }

    isValidPosition(row, col) {
        return row >= 0 && row < 8 && col >= 0 && col < 8;
    }

    isOpponentPiece(piece, color) {
        return piece && piece.color !== color;
    }

    isSameColorPiece(piece, color) {
        return piece && piece.color === color;
    }

    // Get all valid moves for a piece at a given position
    getValidMoves(fromRow, fromCol) {
        const piece = this.getPiece(fromRow, fromCol);
        if (!piece || piece.color !== this.currentPlayer) {
            return [];
        }

        let moves = [];
        
        switch (piece.type) {
            case PIECES.PAWN:
                moves = this.getPawnMoves(fromRow, fromCol, piece.color);
                break;
            case PIECES.ROOK:
                moves = this.getRookMoves(fromRow, fromCol, piece.color);
                break;
            case PIECES.BISHOP:
                moves = this.getBishopMoves(fromRow, fromCol, piece.color);
                break;
            case PIECES.QUEEN:
                moves = [...this.getRookMoves(fromRow, fromCol, piece.color),
                        ...this.getBishopMoves(fromRow, fromCol, piece.color)];
                break;
            case PIECES.KNIGHT:
                moves = this.getKnightMoves(fromRow, fromCol, piece.color);
                break;
            case PIECES.KING:
                moves = this.getKingMoves(fromRow, fromCol, piece.color);
                break;
        }

        // Filter out moves that would put own king in check
        return moves.filter(move => !this.wouldBeInCheck(fromRow, fromCol, move[0], move[1], piece.color));
    }

    getPawnMoves(row, col, color) {
        const moves = [];
        const direction = color === COLORS.WHITE ? -1 : 1;
        const startRow = color === COLORS.WHITE ? 6 : 1;

        // Forward moves
        const newRow = row + direction;
        if (this.isValidPosition(newRow, col) && !this.getPiece(newRow, col)) {
            moves.push([newRow, col]);
            
            // Two squares from starting position
            if (row === startRow && !this.getPiece(row + 2 * direction, col)) {
                moves.push([row + 2 * direction, col]);
            }
        }

        // Captures
        for (const newCol of [col - 1, col + 1]) {
            if (this.isValidPosition(newRow, newCol)) {
                const targetPiece = this.getPiece(newRow, newCol);
                if (this.isOpponentPiece(targetPiece, color)) {
                    moves.push([newRow, newCol]);
                }
            }
        }

        // En passant
        if (this.enPassantTarget) {
            const [epRow, epCol] = this.enPassantTarget;
            if (row === epRow - direction && Math.abs(col - epCol) === 1) {
                moves.push([epRow, epCol]);
            }
        }

        return moves;
    }

    getRookMoves(row, col, color) {
        const moves = [];
        const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];

        for (const [dRow, dCol] of directions) {
            for (let i = 1; i < 8; i++) {
                const newRow = row + i * dRow;
                const newCol = col + i * dCol;
                
                if (!this.isValidPosition(newRow, newCol)) break;
                
                const targetPiece = this.getPiece(newRow, newCol);
                if (!targetPiece) {
                    moves.push([newRow, newCol]);
                } else {
                    if (this.isOpponentPiece(targetPiece, color)) {
                        moves.push([newRow, newCol]);
                    }
                    break;
                }
            }
        }

        return moves;
    }

    getBishopMoves(row, col, color) {
        const moves = [];
        const directions = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

        for (const [dRow, dCol] of directions) {
            for (let i = 1; i < 8; i++) {
                const newRow = row + i * dRow;
                const newCol = col + i * dCol;
                
                if (!this.isValidPosition(newRow, newCol)) break;
                
                const targetPiece = this.getPiece(newRow, newCol);
                if (!targetPiece) {
                    moves.push([newRow, newCol]);
                } else {
                    if (this.isOpponentPiece(targetPiece, color)) {
                        moves.push([newRow, newCol]);
                    }
                    break;
                }
            }
        }

        return moves;
    }

    getKnightMoves(row, col, color) {
        const moves = [];
        const knightMoves = [
            [-2, -1], [-2, 1], [-1, -2], [-1, 2],
            [1, -2], [1, 2], [2, -1], [2, 1]
        ];

        for (const [dRow, dCol] of knightMoves) {
            const newRow = row + dRow;
            const newCol = col + dCol;
            
            if (this.isValidPosition(newRow, newCol)) {
                const targetPiece = this.getPiece(newRow, newCol);
                if (!targetPiece || this.isOpponentPiece(targetPiece, color)) {
                    moves.push([newRow, newCol]);
                }
            }
        }

        return moves;
    }

    getKingMoves(row, col, color) {
        const moves = [];
        const kingMoves = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];

        for (const [dRow, dCol] of kingMoves) {
            const newRow = row + dRow;
            const newCol = col + dCol;
            
            if (this.isValidPosition(newRow, newCol)) {
                const targetPiece = this.getPiece(newRow, newCol);
                if (!targetPiece || this.isOpponentPiece(targetPiece, color)) {
                    moves.push([newRow, newCol]);
                }
            }
        }

        // Castling
        if (!this.isInCheck(color)) {
            // Kingside castling
            if (this.castlingRights[color].kingside) {
                if (!this.getPiece(row, 5) && !this.getPiece(row, 6)) {
                    if (!this.isSquareAttacked(row, 5, color) && !this.isSquareAttacked(row, 6, color)) {
                        moves.push([row, 6]);
                    }
                }
            }
            
            // Queenside castling
            if (this.castlingRights[color].queenside) {
                if (!this.getPiece(row, 1) && !this.getPiece(row, 2) && !this.getPiece(row, 3)) {
                    if (!this.isSquareAttacked(row, 2, color) && !this.isSquareAttacked(row, 3, color)) {
                        moves.push([row, 2]);
                    }
                }
            }
        }

        return moves;
    }

    // Check if a square is under attack by the opponent
    isSquareAttacked(row, col, defendingColor) {
        const attackingColor = defendingColor === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE;
        
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = this.getPiece(r, c);
                if (piece && piece.color === attackingColor) {
                    const moves = this.getPieceAttacks(r, c, piece);
                    if (moves.some(([attackRow, attackCol]) => attackRow === row && attackCol === col)) {
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    // Get all squares a piece can attack (similar to valid moves but ignores check)
    getPieceAttacks(row, col, piece) {
        switch (piece.type) {
            case PIECES.PAWN:
                return this.getPawnAttacks(row, col, piece.color);
            case PIECES.ROOK:
                return this.getRookMoves(row, col, piece.color);
            case PIECES.BISHOP:
                return this.getBishopMoves(row, col, piece.color);
            case PIECES.QUEEN:
                return [...this.getRookMoves(row, col, piece.color),
                        ...this.getBishopMoves(row, col, piece.color)];
            case PIECES.KNIGHT:
                return this.getKnightMoves(row, col, piece.color);
            case PIECES.KING:
                return this.getKingAttacks(row, col, piece.color);
            default:
                return [];
        }
    }

    getPawnAttacks(row, col, color) {
        const attacks = [];
        const direction = color === COLORS.WHITE ? -1 : 1;
        const newRow = row + direction;
        
        for (const newCol of [col - 1, col + 1]) {
            if (this.isValidPosition(newRow, newCol)) {
                attacks.push([newRow, newCol]);
            }
        }
        
        return attacks;
    }

    getKingAttacks(row, col, color) {
        const attacks = [];
        const kingMoves = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];

        for (const [dRow, dCol] of kingMoves) {
            const newRow = row + dRow;
            const newCol = col + dCol;
            
            if (this.isValidPosition(newRow, newCol)) {
                attacks.push([newRow, newCol]);
            }
        }

        return attacks;
    }

    isInCheck(color) {
        const kingPos = this.kingPositions[color];
        return this.isSquareAttacked(kingPos[0], kingPos[1], color);
    }

    wouldBeInCheck(fromRow, fromCol, toRow, toCol, color) {
        // Make a temporary move
        const originalPiece = this.getPiece(toRow, toCol);
        const movingPiece = this.getPiece(fromRow, fromCol);
        
        this.setPiece(toRow, toCol, movingPiece);
        this.setPiece(fromRow, fromCol, null);
        
        // Update king position if king moved
        let originalKingPos = null;
        if (movingPiece.type === PIECES.KING) {
            originalKingPos = [...this.kingPositions[color]];
            this.kingPositions[color] = [toRow, toCol];
        }
        
        const inCheck = this.isInCheck(color);
        
        // Restore original position
        this.setPiece(fromRow, fromCol, movingPiece);
        this.setPiece(toRow, toCol, originalPiece);
        if (originalKingPos) {
            this.kingPositions[color] = originalKingPos;
        }
        
        return inCheck;
    }

    makeMove(fromRow, fromCol, toRow, toCol, promotion = null) {
        const piece = this.getPiece(fromRow, fromCol);
        if (!piece || piece.color !== this.currentPlayer) {
            return { success: false, error: 'Invalid piece or not your turn' };
        }

        const validMoves = this.getValidMoves(fromRow, fromCol);
        const isValidMove = validMoves.some(([r, c]) => r === toRow && c === toCol);
        
        if (!isValidMove) {
            return { success: false, error: 'Invalid move' };
        }

        const capturedPiece = this.getPiece(toRow, toCol);
        const move = {
            from: [fromRow, fromCol],
            to: [toRow, toCol],
            piece: piece.type,
            color: piece.color,
            captured: capturedPiece,
            castling: null,
            enPassant: false,
            promotion: promotion,
            check: false,
            checkmate: false
        };

        // Handle special moves
        this.handleSpecialMoves(move, fromRow, fromCol, toRow, toCol, piece);

        // Make the move
        this.setPiece(toRow, toCol, piece);
        this.setPiece(fromRow, fromCol, null);

        // Handle promotion
        if (promotion && piece.type === PIECES.PAWN) {
            this.setPiece(toRow, toCol, { type: promotion, color: piece.color });
        }

        // Update king position
        if (piece.type === PIECES.KING) {
            this.kingPositions[piece.color] = [toRow, toCol];
        }

        // Add captured piece to list
        if (capturedPiece) {
            this.capturedPieces[capturedPiece.color].push(capturedPiece);
        }

        // Update castling rights
        this.updateCastlingRights(fromRow, fromCol, toRow, toCol, piece);

        // Update en passant target
        this.updateEnPassant(fromRow, fromCol, toRow, toCol, piece);

        // Switch players
        this.currentPlayer = this.currentPlayer === COLORS.WHITE ? COLORS.BLACK : COLORS.WHITE;

        // Check for check/checkmate
        move.check = this.isInCheck(this.currentPlayer);
        if (move.check) {
            const hasValidMoves = this.hasValidMoves(this.currentPlayer);
            if (!hasValidMoves) {
                move.checkmate = true;
                this.gameState = GAME_STATES.CHECKMATE;
            } else {
                this.gameState = GAME_STATES.CHECK;
            }
        } else {
            // Check for stalemate
            if (!this.hasValidMoves(this.currentPlayer)) {
                this.gameState = GAME_STATES.STALEMATE;
            } else {
                this.gameState = GAME_STATES.ACTIVE;
            }
        }

        // Update move counters
        if (piece.type === PIECES.PAWN || capturedPiece) {
            this.halfmoveClock = 0;
        } else {
            this.halfmoveClock++;
        }

        if (this.currentPlayer === COLORS.WHITE) {
            this.fullmoveNumber++;
        }

        // Add to move history
        this.moveHistory.push(move);
        
        // Set last move for UI highlighting
        this.lastMove = {
            fromRow: fromRow,
            fromCol: fromCol,
            toRow: toRow,
            toCol: toCol
        };

        return { success: true, move, gameState: this.gameState };
    }

    handleSpecialMoves(move, fromRow, fromCol, toRow, toCol, piece) {
        // Castling
        if (piece.type === PIECES.KING && Math.abs(toCol - fromCol) === 2) {
            move.castling = toCol > fromCol ? 'kingside' : 'queenside';
            
            // Move the rook
            if (toCol > fromCol) { // Kingside
                const rook = this.getPiece(fromRow, 7);
                this.setPiece(fromRow, 5, rook);
                this.setPiece(fromRow, 7, null);
            } else { // Queenside
                const rook = this.getPiece(fromRow, 0);
                this.setPiece(fromRow, 3, rook);
                this.setPiece(fromRow, 0, null);
            }
        }

        // En passant
        if (piece.type === PIECES.PAWN && this.enPassantTarget) {
            const [epRow, epCol] = this.enPassantTarget;
            if (toRow === epRow && toCol === epCol) {
                move.enPassant = true;
                move.captured = this.getPiece(fromRow, toCol);
                this.setPiece(fromRow, toCol, null); // Remove the captured pawn
            }
        }
    }

    updateCastlingRights(fromRow, fromCol, toRow, toCol, piece) {
        // King moves
        if (piece.type === PIECES.KING) {
            this.castlingRights[piece.color].kingside = false;
            this.castlingRights[piece.color].queenside = false;
        }

        // Rook moves
        if (piece.type === PIECES.ROOK) {
            if (fromCol === 0) {
                this.castlingRights[piece.color].queenside = false;
            } else if (fromCol === 7) {
                this.castlingRights[piece.color].kingside = false;
            }
        }

        // Rook captured
        if (toRow === 0 || toRow === 7) {
            const color = toRow === 0 ? COLORS.BLACK : COLORS.WHITE;
            if (toCol === 0) {
                this.castlingRights[color].queenside = false;
            } else if (toCol === 7) {
                this.castlingRights[color].kingside = false;
            }
        }
    }

    updateEnPassant(fromRow, fromCol, toRow, toCol, piece) {
        // Reset en passant target
        this.enPassantTarget = null;

        // Set en passant target for pawn double moves
        if (piece.type === PIECES.PAWN && Math.abs(toRow - fromRow) === 2) {
            this.enPassantTarget = [(fromRow + toRow) / 2, toCol];
        }
    }

    hasValidMoves(color) {
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const piece = this.getPiece(row, col);
                if (piece && piece.color === color) {
                    const moves = this.getValidMoves(row, col);
                    if (moves.length > 0) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // Get algebraic notation for a move
    getAlgebraicNotation(move) {
        const { from, to, piece, captured, castling, promotion, check, checkmate } = move;
        
        // Validate move object
        if (!move || !from || !to || !Array.isArray(from) || !Array.isArray(to)) {
            throw new Error('Invalid move object for notation');
        }
        
        if (from.length !== 2 || to.length !== 2) {
            throw new Error('Invalid move coordinates');
        }
        
        if (typeof from[0] !== 'number' || typeof from[1] !== 'number' || 
            typeof to[0] !== 'number' || typeof to[1] !== 'number') {
            throw new Error('Move coordinates must be numbers');
        }
        
        if (castling) {
            return castling === 'kingside' ? 'O-O' : 'O-O-O';
        }

        let notation = '';
        
        if (piece && piece !== PIECES.PAWN) {
            notation += piece.toUpperCase();
        }

        // Add disambiguation if needed
        // (This is simplified - full implementation would check for ambiguity)
        
        if (captured) {
            if (piece === PIECES.PAWN) {
                notation += String.fromCharCode(97 + from[1]); // File letter
            }
            notation += 'x';
        }

        notation += String.fromCharCode(97 + to[1]) + (8 - to[0]);

        if (promotion) {
            notation += '=' + promotion.toUpperCase();
        }

        if (checkmate) {
            notation += '#';
        } else if (check) {
            notation += '+';
        }

        return notation;
    }

    // Convert board to FEN notation
    toFEN() {
        let fen = '';
        
        // Board position
        for (let row = 0; row < 8; row++) {
            let emptyCount = 0;
            for (let col = 0; col < 8; col++) {
                const piece = this.getPiece(row, col);
                if (piece) {
                    if (emptyCount > 0) {
                        fen += emptyCount;
                        emptyCount = 0;
                    }
                    let pieceChar = piece.type;
                    if (piece.color === COLORS.WHITE) {
                        pieceChar = pieceChar.toUpperCase();
                    }
                    fen += pieceChar;
                } else {
                    emptyCount++;
                }
            }
            if (emptyCount > 0) {
                fen += emptyCount;
            }
            if (row < 7) {
                fen += '/';
            }
        }

        // Active color
        fen += ' ' + (this.currentPlayer === COLORS.WHITE ? 'w' : 'b');

        // Castling rights
        let castling = '';
        if (this.castlingRights[COLORS.WHITE].kingside) castling += 'K';
        if (this.castlingRights[COLORS.WHITE].queenside) castling += 'Q';
        if (this.castlingRights[COLORS.BLACK].kingside) castling += 'k';
        if (this.castlingRights[COLORS.BLACK].queenside) castling += 'q';
        fen += ' ' + (castling || '-');

        // En passant target
        if (this.enPassantTarget) {
            const [row, col] = this.enPassantTarget;
            fen += ' ' + String.fromCharCode(97 + col) + (8 - row);
        } else {
            fen += ' -';
        }

        // Halfmove and fullmove counters
        fen += ` ${this.halfmoveClock} ${this.fullmoveNumber}`;

        return fen;
    }

    // Clone the current game state
    clone() {
        const clone = new ChessEngine();
        clone.board = this.board.map(row => row.map(piece => piece ? { ...piece } : null));
        clone.currentPlayer = this.currentPlayer;
        clone.gameState = this.gameState;
        clone.moveHistory = [...this.moveHistory];
        clone.capturedPieces = {
            [COLORS.WHITE]: [...this.capturedPieces[COLORS.WHITE]],
            [COLORS.BLACK]: [...this.capturedPieces[COLORS.BLACK]]
        };
        clone.kingPositions = {
            [COLORS.WHITE]: [...this.kingPositions[COLORS.WHITE]],
            [COLORS.BLACK]: [...this.kingPositions[COLORS.BLACK]]
        };
        clone.castlingRights = {
            [COLORS.WHITE]: { ...this.castlingRights[COLORS.WHITE] },
            [COLORS.BLACK]: { ...this.castlingRights[COLORS.BLACK] }
        };
        clone.enPassantTarget = this.enPassantTarget ? [...this.enPassantTarget] : null;
        clone.halfmoveClock = this.halfmoveClock;
        clone.fullmoveNumber = this.fullmoveNumber;
        return clone;
    }
}

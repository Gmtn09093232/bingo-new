const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

// ---------- Game state ----------
let players = {};           // socketId -> { name, card, marked, cardNumber, id }
let takenCards = new Set(); // card numbers 1..100 that are already selected
let gameActive = false;
let calledNumbers = [];
let autoInterval = null;
let countdownTimeout = null;
let countdownSeconds = 30;
let isLobbyOpen = true;

// Generate deterministic card from number 1..100
function generateCardFromNumber(cardNum) {
    function seededRandom(seed) {
        let x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    }
    function column(min, max, seedOffset) {
        let col = [];
        let seed = cardNum * 131 + seedOffset;
        while (col.length < 5) {
            let n = Math.floor(seededRandom(seed++) * (max - min + 1)) + min;
            if (!col.includes(n)) col.push(n);
        }
        return col;
    }
    let B = column(1, 15, 1);
    let I = column(16, 30, 2);
    let N = column(31, 45, 3);
    let G = column(46, 60, 4);
    let O = column(61, 75, 5);
    let card = [];
    for (let i = 0; i < 5; i++) card.push(B[i], I[i], N[i], G[i], O[i]);
    card[12] = "FREE";
    return card;
}

// Broadcast available cards (not taken)
function broadcastAvailableCards() {
    const available = [];
    for (let i = 1; i <= 100; i++) {
        if (!takenCards.has(i)) available.push(i);
    }
    io.emit('availableCards', available);
}

// Full reset: back to lobby, clear everything
function fullReset() {
    if (autoInterval) clearInterval(autoInterval);
    if (countdownTimeout) clearTimeout(countdownTimeout);
    autoInterval = null;
    gameActive = false;
    calledNumbers = [];
    isLobbyOpen = true;
    countdownSeconds = 30;
    takenCards.clear();
    players = {};
    broadcastAvailableCards();
    io.emit('lobbyReset', { countdown: countdownSeconds });
}

// Start 30‑second countdown (only when first player selects a card)
function startCountdown() {
    if (countdownTimeout) clearTimeout(countdownTimeout);
    countdownSeconds = 30;
    io.emit('countdownTick', countdownSeconds);
    countdownTimeout = setInterval(() => {
        countdownSeconds--;
        io.emit('countdownTick', countdownSeconds);
        if (countdownSeconds <= 0) {
            clearInterval(countdownTimeout);
            countdownTimeout = null;
            startGame();
        }
    }, 1000);
}

// Begin the Bingo round: auto‑call numbers every 4 seconds
function startGame() {
    if (gameActive) return;
    gameActive = true;
    isLobbyOpen = false;
    calledNumbers = [];
    io.emit('gameStarted');

    // Reset each player's marked cells (cards stay same)
    for (let id in players) {
        const p = players[id];
        p.marked = new Array(25).fill(false);
        p.marked[12] = true; // FREE always marked
        io.to(id).emit('cardAssigned', {
            playerId: id,
            card: p.card,
            gameActive: true
        });
    }

    if (autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(() => {
        if (!gameActive) return;
        let available = [];
        for (let i = 1; i <= 75; i++) {
            if (!calledNumbers.includes(i)) available.push(i);
        }
        if (available.length === 0) {
            fullReset();
            return;
        }
        const newNumber = available[Math.floor(Math.random() * available.length)];
        calledNumbers.push(newNumber);
        io.emit('newNumber', newNumber);
    }, 4000);
}

// Win detection: rows, columns, diagonals, corners
function checkWin(marked) {
    for (let r = 0; r < 5; r++) {
        let win = true;
        for (let c = 0; c < 5; c++) if (!marked[r * 5 + c]) { win = false; break; }
        if (win) return true;
    }
    for (let c = 0; c < 5; c++) {
        let win = true;
        for (let r = 0; r < 5; r++) if (!marked[r * 5 + c]) { win = false; break; }
        if (win) return true;
    }
    let diag1 = true;
    for (let i = 0; i < 5; i++) if (!marked[i * 5 + i]) { diag1 = false; break; }
    if (diag1) return true;
    let diag2 = true;
    for (let i = 0; i < 5; i++) if (!marked[i * 5 + (4 - i)]) { diag2 = false; break; }
    if (diag2) return true;
    const corners = [0, 4, 20, 24];
    let cornersWin = true;
    for (let idx of corners) if (!marked[idx]) { cornersWin = false; break; }
    if (cornersWin) return true;
    return false;
}

// Handle player marking a cell
function handleMark(socketId, cellIndex, numberValue) {
    const player = players[socketId];
    if (!player || !gameActive) return false;
    if (!calledNumbers.includes(numberValue)) return false;
    if (player.card[cellIndex] !== numberValue) return false;
    if (player.marked[cellIndex]) return false;

    player.marked[cellIndex] = true;
    io.to(socketId).emit('markConfirmed', { cellIndex, number: numberValue });

    if (checkWin(player.marked)) {
        gameActive = false;
        if (autoInterval) clearInterval(autoInterval);
        autoInterval = null;
        io.emit('gameWinner', { winnerId: socketId, winnerName: player.name });
        setTimeout(() => {
            fullReset();
            // If any player remains, start countdown again? Actually fullReset clears players,
            // so next join will trigger startCountdown. But we can restart countdown only if someone joins.
        }, 5000);
        return true;
    }
    return false;
}

// Socket events
io.on('connection', (socket) => {
    console.log('Client connected', socket.id);

    // Send current state
    const available = [];
    for (let i = 1; i <= 100; i++) if (!takenCards.has(i)) available.push(i);
    socket.emit('availableCards', available);
    socket.emit('lobbyState', { isLobbyOpen, countdown: countdownSeconds, gameActive });

    socket.on('selectCard', ({ name, cardNumber }) => {
        if (!isLobbyOpen) {
            socket.emit('joinError', 'Game already started, cannot select card now.');
            return;
        }
        let num = parseInt(cardNumber);
        if (isNaN(num) || num < 1 || num > 100) {
            socket.emit('joinError', 'Invalid card number (1-100)');
            return;
        }
        if (takenCards.has(num)) {
            socket.emit('joinError', `Card ${num} is already taken.`);
            return;
        }
        // If player already had a card, free the old one
        if (players[socket.id]) {
            const oldCard = players[socket.id].cardNumber;
            takenCards.delete(oldCard);
        }
        takenCards.add(num);
        const card = generateCardFromNumber(num);
        const marked = new Array(25).fill(false);
        marked[12] = true;
        players[socket.id] = {
            id: socket.id,
            name: name || 'Guest',
            cardNumber: num,
            card: card,
            marked: marked,
        };
        socket.emit('cardAssigned', {
            playerId: socket.id,
            card: card,
            gameActive: false
        });
        broadcastAvailableCards();
        broadcastPlayers();

        // Start countdown on first card selection
        if (Object.keys(players).length === 1 && isLobbyOpen && !countdownTimeout) {
            startCountdown();
        }
    });

    socket.on('markNumber', ({ cellIndex, number }) => {
        handleMark(socket.id, cellIndex, number);
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const cardNum = players[socket.id].cardNumber;
            takenCards.delete(cardNum);
            delete players[socket.id];
            broadcastAvailableCards();
            broadcastPlayers();
        }
        if (Object.keys(players).length === 0 && autoInterval) {
            clearInterval(autoInterval);
            autoInterval = null;
            gameActive = false;
            isLobbyOpen = true;
            if (countdownTimeout) clearTimeout(countdownTimeout);
            countdownTimeout = null;
            countdownSeconds = 30;
        }
    });
});

function broadcastPlayers() {
    const playerList = Object.values(players).map(p => ({ id: p.id, name: p.name, cardNumber: p.cardNumber }));
    io.emit('playersList', playerList);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bingo server running on port ${PORT}`));
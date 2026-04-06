const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'bingo_super_secret_key_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

// Serve static files (optional)
app.use(express.static('public'));

// User data storage (JSON file)
const USERS_FILE = './users.json';
fs.ensureFileSync(USERS_FILE);
let users = {};
try {
    users = fs.readJsonSync(USERS_FILE);
} catch (e) { users = {}; }

function saveUsers() {
    fs.writeJsonSync(USERS_FILE, users, { spaces: 2 });
}

// Helper: get user by session
function getLoggedInUser(req) {
    if (!req.session.userId) return null;
    return users[req.session.userId];
}

// ---------- AUTH ENDPOINTS ----------
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (users[username]) return res.status(400).json({ error: 'Username already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    users[username] = {
        userId,
        username,
        password: hashedPassword,
        balance: 100, // Starting bonus credits
        createdAt: new Date().toISOString()
    };
    saveUsers();
    req.session.userId = userId;
    req.session.username = username;
    res.json({ success: true, username, balance: users[username].balance });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId = user.userId;
    req.session.username = username;
    res.json({ success: true, username, balance: user.balance });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    const user = getLoggedInUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    res.json({ username: user.username, balance: user.balance });
});

// ---------- BALANCE ENDPOINTS ----------
app.post('/api/deposit', async (req, res) => {
    const user = getLoggedInUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { amount, paymentMethod } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    
    // Here you would integrate Telebirr/Chapa payment gateway.
    // For demo, we simulate success after "payment".
    // In real implementation, you would create a payment session and wait for webhook.
    
    // Simulate immediate deposit (for testing)
    user.balance += numAmount;
    saveUsers();
    res.json({ success: true, newBalance: user.balance });
});

app.post('/api/withdraw', async (req, res) => {
    const user = getLoggedInUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (user.balance < numAmount) return res.status(400).json({ error: 'Insufficient balance' });
    
    // For withdrawal, you would integrate a payout API (Telebirr disbursement).
    // Here we just deduct balance (simulate).
    user.balance -= numAmount;
    saveUsers();
    res.json({ success: true, newBalance: user.balance });
});

// ---------- GAME STATE (from previous) ----------
let players = {};           // socketId -> { name, card, marked, cardNumber, userId, username }
let takenCards = new Set();
let gameActive = false;
let calledNumbers = [];
let autoInterval = null;
let countdownTimeout = null;
let countdownSeconds = 30;
let isLobbyOpen = true;

// Cost per game (in credits)
const GAME_COST = 5;

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

function broadcastAvailableCards() {
    const available = [];
    for (let i = 1; i <= 100; i++) if (!takenCards.has(i)) available.push(i);
    io.emit('availableCards', available);
}

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

function startCountdown() {
    if (countdownTimeout) clearInterval(countdownTimeout);
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

function startGame() {
    if (gameActive) return;
    // Deduct game cost from all participating users BEFORE game starts
    const playersToRemove = [];
    for (let id in players) {
        const p = players[id];
        const user = users[p.username];
        if (!user || user.balance < GAME_COST) {
            playersToRemove.push(id);
            io.to(id).emit('error', `Insufficient balance (need ${GAME_COST} credits). Please deposit.`);
        } else {
            user.balance -= GAME_COST;
            saveUsers();
            io.to(id).emit('balanceUpdate', user.balance);
        }
    }
    playersToRemove.forEach(id => {
        const cardNum = players[id].cardNumber;
        takenCards.delete(cardNum);
        delete players[id];
    });
    broadcastAvailableCards();
    
    if (Object.keys(players).length === 0) {
        io.emit('gameError', 'No players with enough balance. Game canceled.');
        fullReset();
        return;
    }
    
    gameActive = true;
    isLobbyOpen = false;
    calledNumbers = [];
    io.emit('gameStarted');
    
    for (let id in players) {
        const p = players[id];
        p.marked = new Array(25).fill(false);
        p.marked[12] = true;
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
        for (let i = 1; i <= 75; i++) if (!calledNumbers.includes(i)) available.push(i);
        if (available.length === 0) {
            fullReset();
            return;
        }
        const newNumber = available[Math.floor(Math.random() * available.length)];
        calledNumbers.push(newNumber);
        io.emit('newNumber', newNumber);
    }, 4000);
}

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
    return cornersWin;
}

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
        // Award winner with prize (e.g., 50 credits)
        const winnerUser = users[player.username];
        if (winnerUser) {
            winnerUser.balance += 50;
            saveUsers();
            io.to(socketId).emit('balanceUpdate', winnerUser.balance);
        }
        io.emit('gameWinner', { winnerId: socketId, winnerName: player.name });
        setTimeout(() => fullReset(), 5000);
        return true;
    }
    return false;
}

// Socket.io with authentication integration
io.use((socket, next) => {
    const sessionID = socket.handshake.auth.sessionID;
    if (!sessionID) return next(new Error('No session'));
    // We'll rely on client sending userId after login
    next();
});

io.on('connection', (socket) => {
    console.log('Client connected', socket.id);
    
    socket.on('auth', ({ userId, username }) => {
        socket.userId = userId;
        socket.username = username;
        // Send current game state
        const available = [];
        for (let i = 1; i <= 100; i++) if (!takenCards.has(i)) available.push(i);
        socket.emit('availableCards', available);
        socket.emit('lobbyState', { isLobbyOpen, countdown: countdownSeconds, gameActive });
        socket.emit('balanceUpdate', users[username]?.balance || 0);
    });
    
    socket.on('selectCard', ({ name, cardNumber }) => {
        if (!isLobbyOpen) {
            socket.emit('joinError', 'Game already started');
            return;
        }
        const num = parseInt(cardNumber);
        if (isNaN(num) || num < 1 || num > 100) return;
        if (takenCards.has(num)) {
            socket.emit('joinError', `Card ${num} already taken`);
            return;
        }
        if (players[socket.id]) {
            takenCards.delete(players[socket.id].cardNumber);
        }
        takenCards.add(num);
        const card = generateCardFromNumber(num);
        const marked = new Array(25).fill(false);
        marked[12] = true;
        players[socket.id] = {
            id: socket.id,
            name: name,
            cardNumber: num,
            card: card,
            marked: marked,
            userId: socket.userId,
            username: socket.username
        };
        socket.emit('cardAssigned', { playerId: socket.id, card, gameActive: false });
        broadcastAvailableCards();
        broadcastPlayers();
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

const PORT = process.env.PORT || 1000;
server.listen(PORT, () => console.log(`Bingo server running on port ${PORT}`));
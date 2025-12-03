const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Middleware ---
app.use(express.json());
app.use(express.static('public'));

// --- In-Memory "Database" ---
// For a real app, you'd use a proper database like PostgreSQL or MongoDB.
const users = {}; // { 'username': { passwordHash: '...' } }
const onlineUsers = new Map(); // { socketId: 'username' }
const chatSessions = new Map(); // { 'sessionId': { user1: '...', user2: '...', messages: [...] } }

// --- Authentication Routes ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (users[username]) return res.status(400).json({ error: 'User already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    users[username] = { passwordHash };
    console.log(`✅ User registered: ${username}`);
    res.status(201).json({ message: 'User registered successfully' });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!users[username] || !(await bcrypt.compare(password, users[username].passwordHash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    console.log(`🔑 User logged in: ${username}`);
    res.status(200).json({ message: 'Login successful' });
});

// --- Socket.io Logic ---
io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // --- User Authentication & Online Status ---
    socket.on('authenticate', async ({ username, password }) => {
        if (!users[username] || !(await bcrypt.compare(password, users[username].passwordHash))) {
            socket.emit('auth-error', 'Invalid credentials');
            return;
        }
        onlineUsers.set(socket.id, username);
        socket.username = username; // Store username on the socket object
        io.emit('user-list-updated', Array.from(onlineUsers.values()));
        console.log(`✅ Authenticated: ${username}`);
    });

    // --- Chat Room Management ---
    socket.on('start-chat', ({ targetUser }) => {
        const user1 = socket.username;
        const user2 = targetUser;
        if (!user1 || !user2) return;

        // Find existing session or create a new one
        let sessionId = [...chatSession.entries()].find(([id, session]) =>
            (session.user1 === user1 && session.user2 === user2) || (session.user1 === user2 && session.user2 === user1)
        )?.[0];

        if (!sessionId) {
            sessionId = `chat_${Date.now()}`;
            chatSessions.set(sessionId, { user1, user2, messages: [] });
        }
        
        const targetSocketId = [...onlineUsers.entries()].find(([id, name]) => name === user2)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('chat-invitation', { from: user1, sessionId });
        }
    });

    socket.on('accept-chat', ({ sessionId }) => {
        const session = chatSessions.get(sessionId);
        if (!session || (session.user1 !== socket.username && session.user2 !== socket.username)) return;
        
        socket.join(sessionId);
        const otherUser = session.user1 === socket.username ? session.user2 : session.user1;
        const otherSocketId = [...onlineUsers.entries()].find(([id, name]) => name === otherUser)?.[0];
        if (otherSocketId) {
            io.to(otherSocketId).socketsJoin(sessionId);
            io.to(sessionId).emit('chat-started', { sessionId, with: otherUser });
        }
    });

    // --- Messaging & E2EE ---
    socket.on('send-message', ({ sessionId, encryptedData }) => {
        const session = chatSessions.get(sessionId);
        if (!session) return;
        
        const fullMessage = { sender: socket.username, ...encryptedData, timestamp: new Date() };
        session.messages.push(fullMessage);
        
        // Broadcast to the room, but not back to the sender
        socket.to(sessionId).emit('new-message', fullMessage);
    });

    // --- Typing Indicators ---
    socket.on('typing-start', (sessionId) => {
        socket.to(sessionId).emit('user-typing', { user: socket.username, isTyping: true });
    });

    socket.on('typing-stop', (sessionId) => {
        socket.to(sessionId).emit('user-typing', { user: socket.username, isTyping: false });
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.delete(socket.id);
            io.emit('user-list-updated', Array.from(onlineUsers.values()));
            console.log(`❌ User disconnected: ${socket.username}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Advanced Server running at http://localhost:${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs/promises');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the "public" folder as static files
app.use(express.static('public'));

// --- Simple Local Message Store ---
const MESSAGE_FILE_PATH = path.join(__dirname, 'messages.json');
let messages = [];

const loadMessages = async () => {
    try {
        const data = await fs.readFile(MESSAGE_FILE_PATH, 'utf-8');
        messages = JSON.parse(data);
        console.log(`📜 Loaded ${messages.length} messages.`);
    } catch (error) {
        console.log('No messages file found. Starting fresh.');
        messages = [];
    }
};

const saveMessages = async () => {
    try {
        await fs.writeFile(MESSAGE_FILE_PATH, JSON.stringify(messages, null, 2));
        console.log('💾 Messages saved.');
    } catch (error) {
        console.error("Failed to save messages:", error);
    }
};

// Load messages on startup
loadMessages();

// Save messages every 30 seconds
setInterval(saveMessages, 30000);

// --- Socket.io Logic ---
const publicKeys = new Map();
const userToSocket = new Map();
const socketToUser = new Map();

io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    socket.on('register-user', (userId) => {
        socketToUser.set(socket.id, userId);
        userToSocket.set(userId, socket.id);
        console.log(`✅ User registered: ${userId}`);
    });

    socket.on('registerPublicKey', (data) => {
        const userId = socketToUser.get(socket.id);
        if (userId) {
            publicKeys.set(userId, data.publicKey);
            console.log(`🔑 Public key registered for ${userId}`);
        }
    });

    socket.on('getPublicKey', (targetUserId) => {
        const key = publicKeys.get(targetUserId);
        if (key) {
            socket.emit('publicKey', { userId: targetUserId, publicKey: key });
        }
    });

    socket.on('sendMessage', (msgData) => {
        const senderId = socketToUser.get(socket.id);
        if (!senderId) return;

        const fullMessage = { ...msgData, senderId, timestamp: new Date() };
        messages.push(fullMessage);

        const targetSocketId = userToSocket.get(msgData.receiverId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('newMessage', fullMessage);
        }
    });

    socket.on('disconnect', () => {
        const userId = socketToUser.get(socket.id);
        if (userId) {
            console.log(`❌ User disconnected: ${userId}`);
            socketToUser.delete(socket.id);
            userToSocket.delete(userId);
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

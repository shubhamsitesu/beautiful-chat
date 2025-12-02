// Import necessary modules
const express = require('express'); // Web framework for Node.js
const http = require('http'); // Node's built-in HTTP module
const { Server } = require("socket.io"); // Socket.io for real-time communication
const fs = require('fs/promises'); // File system module with promise-based API
const path = require('path'); // Module for handling file paths

// Create an Express application and an HTTP server
const app = express();
const server = http.createServer(app);
// Create a new Socket.io server, attaching it to the HTTP server
const io = new Server(server);

// Serve the "public" folder as static files. This makes index.html, style.css, etc. accessible.
app.use(express.static('public'));

// --- Simple Local Message Store ---
// This is a simple file-based database for storing messages.

const MESSAGE_FILE_PATH = path.join(__dirname, 'messages.json');
let messages = []; // In-memory array to hold messages for fast access

// Function to load messages from the file when the server starts
const loadMessages = async () => {
    try {
        const data = await fs.readFile(MESSAGE_FILE_PATH, 'utf-8');
        messages = JSON.parse(data);
        console.log(`📜 Loaded ${messages.length} messages.`);
    } catch (error) {
        // If the file doesn't exist, it's the first time running the server.
        console.log('No messages file found. Starting fresh.');
        messages = [];
    }
};

// Function to save the in-memory messages to the file
const saveMessages = async () => {
    try {
        // Write the messages array to the file, nicely formatted with JSON.stringify
        await fs.writeFile(MESSAGE_FILE_PATH, JSON.stringify(messages, null, 2));
        console.log('💾 Messages saved.');
    } catch (error) {
        console.error("Failed to save messages:", error);
    }
};

// Load messages on server startup
loadMessages();
// Save messages to the file every 30 seconds
setInterval(saveMessages, 30000);

// --- Socket.io Logic ---
// This is where all the real-time magic happens

// In-memory Maps to store user information and keys
const publicKeys = new Map(); // userId -> publicKey
const userToSocket = new Map(); // userId -> socket.id
const socketToUser = new Map(); // socket.id -> userId

// Listen for new socket connections
io.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // When a user registers their username
    socket.on('register-user', (userId) => {
        socketToUser.set(socket.id, userId);
        userToSocket.set(userId, socket.id);
        console.log(`✅ User registered: ${userId}`);
    });

    // When a user registers their public key for E2EE
    socket.on('registerPublicKey', (data) => {
        const userId = socketToUser.get(socket.id);
        if (userId) {
            publicKeys.set(userId, data.publicKey);
            console.log(`🔑 Public key registered for ${userId}`);
        }
    });

    // When a user requests another user's public key
    socket.on('getPublicKey', (targetUserId) => {
        const key = publicKeys.get(targetUserId);
        if (key) {
            // Send the public key back to the requesting user's socket
            socket.emit('publicKey', { userId: targetUserId, publicKey: key });
        }
    });

    // When a user sends a message
    socket.on('sendMessage', (msgData) => {
        const senderId = socketToUser.get(socket.id);
        if (!senderId) return; // Ignore messages from unregistered users

        // Create a full message object with sender, timestamp, etc.
        const fullMessage = { ...msgData, senderId, timestamp: new Date() };
        // Store the encrypted message in our in-memory array
        messages.push(fullMessage);

        // Find the socket ID of the intended recipient
        const targetSocketId = userToSocket.get(msgData.receiverId);
        if (targetSocketId) {
            // Send the encrypted message directly to the recipient's socket
            io.to(targetSocketId).emit('newMessage', fullMessage);
        }
    });

    // When a user disconnects (closes the tab)
    socket.on('disconnect', () => {
        const userId = socketToUser.get(socket.id);
        if (userId) {
            console.log(`❌ User disconnected: ${userId}`);
            // Clean up our maps
            socketToUser.delete(socket.id);
            userToSocket.delete(userId);
        }
    });
});

// Start the server and listen for incoming connections on the specified port
const PORT = process.env.PORT || 3000; // Use the port from environment variable or default to 3000
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

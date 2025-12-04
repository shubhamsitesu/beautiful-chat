const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); 
require('dotenv').config(); // Load secrets from Render's Environment Variables

// --- FIXED CONFIGURATION (CRITICAL) ---
const FIXED_LOGIN_PASSWORD = process.env.CHAT_LOGIN_PASSWORD; 
const FIXED_SECRET_KEY = process.env.CHAT_SECRET_KEY; 

// Check if secrets are loaded correctly
if (!FIXED_LOGIN_PASSWORD || !FIXED_SECRET_KEY) {
    console.error("FATAL ERROR: Secrets (CHAT_LOGIN_PASSWORD or CHAT_SECRET_KEY) not loaded from Environment Variables. Please check Render dashboard.");
    process.exit(1); 
}

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; 

const CHAT_HISTORY_FILE = 'chat_history.json';
const FIXED_ROOM_KEY = 'fixed_chat_room'; 

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*" },
    pingTimeout: 60000 
});

let chatHistory = [];

// --- ENCRYPTION/DECRYPTION FUNCTIONS ---
function encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(FIXED_SECRET_KEY, 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text) return '';
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(FIXED_SECRET_KEY, 'utf8'), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return "Decryption Error";
    }
}

// --- PERSISTENCE UTILITIES ---

function loadHistory() {
    // Check if file exists before trying to read it
    if (!fs.existsSync(CHAT_HISTORY_FILE)) return;
    
    try {
        const encryptedHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
        // Decrypt history before storing in memory
        chatHistory = encryptedHistory.map(msg => ({
            ...msg,
            text: decrypt(msg.text)
        }));
    } catch (e) {
        console.error("Error loading history (File may be corrupt/empty):", e.message);
        chatHistory = [];
    }
}

function saveHistory(message) {
    chatHistory.push(message); 
    // Encrypt the history before writing to disk
    const encryptedHistory = chatHistory.map(msg => ({
        ...msg,
        text: encrypt(msg.text)
    }));
    try {
        // This command creates the file if it doesn't exist on Render's disk
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(encryptedHistory, null, 2));
    } catch (e) {
        console.error("Error saving chat history:", e);
    }
}

function deleteMessageFromHistory(messageId) {
    const initialLength = chatHistory.length;
    chatHistory = chatHistory.filter(msg => msg.id !== messageId);
    
    if (chatHistory.length < initialLength) {
        // Rewrite the file only if a message was actually deleted
        const encryptedHistory = chatHistory.map(msg => ({ ...msg, text: encrypt(msg.text) }));
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(encryptedHistory, null, 2));
    }
}

loadHistory(); 

// --- EXPRESS SETUP ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); 

// --- SOCKET.IO LOGIC ---

io.on('connection', (socket) => {
    
    // AUTHENTICATION (Password Only)
    socket.on('authenticate-user', ({ password }) => {
        if (password === FIXED_LOGIN_PASSWORD) {
            
            // --- CRITICAL FIX APPLIED HERE ---
            // 1. Check for existing partner:
            const partnerId = Array.from(io.sockets.adapter.rooms.get(FIXED_ROOM_KEY) || [])
                .find(id => id !== socket.id);
            
            // 2. Assign identity based on who is present (Moved to correct position):
            const userType = partnerId ? 'UserB' : 'UserA'; 
            // ------------------------------------

            socket.join(FIXED_ROOM_KEY);
            socket.data.username = userType; 
            socket.data.room = FIXED_ROOM_KEY;

            // Send success signal back to client
            socket.emit('auth-success', { 
                username: userType, 
                history: chatHistory 
            });

            // Notify the other user (if present) that a partner is online
            socket.to(FIXED_ROOM_KEY).emit('partner-online', userType);
        } else {
            // Authentication Failure
            socket.emit('auth-failure', 'Invalid password.');
        }
    });

    // MESSAGE SENDING 
    socket.on('send-message', (data) => {
        if (!socket.data.username) return; // Ignore if not authenticated
        
        const message = {
            id: data.messageId,
            user: socket.data.username,
            text: data.text,
            timestamp: Date.now()
        };
        
        saveHistory(message); 

        // Send message to the partner
        socket.to(FIXED_ROOM_KEY).emit('receive-message', message);
    });

    // Auto-Delete after view
    socket.on('message-viewed-and-delete', (messageId) => {
        deleteMessageFromHistory(messageId);
        // Send cleanup signal to the sender's screen
        socket.to(FIXED_ROOM_KEY).emit('message-autodeleted-clean', messageId);
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        if (socket.data.room === FIXED_ROOM_KEY) {
            socket.to(FIXED_ROOM_KEY).emit('partner-offline', socket.data.username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

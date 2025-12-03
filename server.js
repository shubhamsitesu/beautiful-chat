const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// FIX: Increased pingTimeout to 60s to prevent mobile disconnects during screen-off
const io = new Server(server, { 
    cors: { origin: "*" },
    pingInterval: 25000,
    pingTimeout: 60000 
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory status tracking (Ephemeral)
const messageStatus = new Map(); 

io.on('connection', (socket) => {
    
    // --- JOIN LOGIC ---
    socket.on('join-chat', ({ username, roomKey }) => {
        const room = roomKey; 
        const users = io.sockets.adapter.rooms.get(room);
        const numClients = users ? users.size : 0;

        if (numClients >= 2) {
            socket.emit('error-message', 'Chat full (2 max).');
            return;
        }

        socket.join(room);
        socket.data.username = username;
        socket.data.room = room;

        socket.emit('system-message', `You joined as ${username}.`);
        
        // Notify partner
        const partnerId = Array.from(io.sockets.adapter.rooms.get(room) || []).find(id => id !== socket.id);
        if (partnerId) {
             const partnerSocket = io.sockets.sockets.get(partnerId);
             socket.emit('partner-online', partnerSocket.data.username);
             io.to(partnerId).emit('partner-online', username);
             io.to(partnerId).emit('system-message', `${username} connected.`);
        }
    });

    // --- MESSAGING LOGIC ---
    socket.on('send-message', ({ encryptedData, messageId, timer }, callback) => {
        const roomKey = socket.data.room;
        const recipientSocketId = Array.from(io.sockets.adapter.rooms.get(roomKey) || [])
            .find(id => id !== socket.id);
        
        const isDelivered = recipientSocketId ? true : false;
        if (typeof callback === 'function') callback(isDelivered);

        if (isDelivered) {
            messageStatus.set(messageId, { senderId: socket.id, roomKey: roomKey });
            io.to(recipientSocketId).emit('receive-message', {
                user: socket.data.username,
                data: encryptedData,
                messageId: messageId,
                timer: timer 
            });
        }
    });

    socket.on('message-viewed', (messageId) => {
        const status = messageStatus.get(messageId); 
        if (status) io.to(status.senderId).emit('message-read', messageId); 
    });

    // --- DELETION LOGIC ---
    socket.on('delete-message', ({ messageId, scope }) => {
        const roomKey = socket.data.room;
        if (scope === 'for_me' || scope === 'for_everyone') {
            socket.emit('message-deleted-local', messageId);
        }
        if (scope === 'for_everyone') {
            socket.to(roomKey).emit('message-deleted-partner', messageId);
        }
    });

    socket.on('clear-chat-room', () => {
        // Only clears for the requester in this version to prevent abuse
        socket.emit('chat-cleared-local');
    });

    socket.on('self-destruct-complete', (messageId) => {
        const status = messageStatus.get(messageId); 
        if (status) {
            io.to(status.senderId).emit('message-deleted-partner', messageId);
            messageStatus.delete(messageId); 
        }
    });

    // --- WEBRTC SIGNALING ---
    socket.on('call-offer', (data) => socket.to(socket.data.room).emit('call-offer', data));
    socket.on('call-answer', (data) => socket.to(socket.data.room).emit('call-answer', data));
    socket.on('ice-candidate', (data) => socket.to(socket.data.room).emit('ice-candidate', data));
    socket.on('end-call', () => socket.to(socket.data.room).emit('end-call'));

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (socket.data.room) socket.to(socket.data.room).emit('partner-offline');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

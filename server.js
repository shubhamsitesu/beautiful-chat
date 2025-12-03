const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// In-memory buffer to track message status for deletion/tick management
// Key: messageId, Value: { senderId, roomKey, timer }
const messageStatus = new Map(); 

io.on('connection', (socket) => {
    
    socket.on('join-chat', ({ username, roomKey }) => {
        const room = roomKey; 
        const users = io.sockets.adapter.rooms.get(room);
        const numClients = users ? users.size : 0;

        // Enforce 2-person limit
        if (numClients >= 2) {
            socket.emit('error-message', 'This chat is full (2 people max). Try a different secret key.');
            return;
        }

        socket.join(room);
        socket.data.username = username;
        socket.data.room = room;

        socket.emit('system-message', `You (${username}) have joined the secure chat.`);
        
        // Find partner and notify status
        const partnerId = Array.from(io.sockets.adapter.rooms.get(room) || []).find(id => id !== socket.id);
        if (partnerId) {
             const partnerSocket = io.sockets.sockets.get(partnerId);
             if(partnerSocket) {
                 // Notify you that partner is online
                 socket.emit('partner-online', partnerSocket.data.username);
                 // Notify partner that you are online
                 io.to(partnerId).emit('partner-online', username);
                 io.to(partnerId).emit('system-message', `${username} has connected.`);
             }
        }
    });

    // --- CHAT MESSAGING & TIMER LOGIC ---
    
    socket.on('send-message', ({ encryptedData, messageId, timer }, callback) => {
        const roomKey = socket.data.room;
        const recipientSocketId = Array.from(io.sockets.adapter.rooms.get(roomKey) || [])
            .find(id => id !== socket.id);
        
        const isDelivered = recipientSocketId ? true : false;
        
        // Acknowledge to the sender (Used for initial tick status)
        if (typeof callback === 'function') callback(isDelivered);

        if (isDelivered) {
            // Store status in memory (LOST if server restarts)
            messageStatus.set(messageId, { senderId: socket.id, roomKey: roomKey, timer: timer });
            
            // Relay to recipient
            io.to(recipientSocketId).emit('receive-message', {
                user: socket.data.username,
                data: encryptedData,
                messageId: messageId,
                timer: timer 
            });
        }
    });

    // Recipient views message -> Trigger 'Read' status
    socket.on('message-viewed', (messageId) => {
        const status = messageStatus.get(messageId); 
        if (status) {
            io.to(status.senderId).emit('message-read', messageId); 
        }
    });

    // Final Self-Destruct Signal
    socket.on('self-destruct-complete', (messageId) => {
        const status = messageStatus.get(messageId); 
        if (status) {
            io.to(status.senderId).emit('message-deleted', messageId);
            messageStatus.delete(messageId); 
        }
    });

    socket.on('typing', () => {
        if(socket.data.room) socket.to(socket.data.room).emit('is-typing', socket.data.username);
    });

    // --- WEBRTC SIGNALING (VIDEO/AUDIO) ---

    socket.on('call-offer', (offer) => {
        if(socket.data.room) {
            socket.to(socket.data.room).emit('call-offer', {
                offer: offer,
                sender: socket.data.username,
                senderId: socket.id
            });
        }
    });

    socket.on('call-answer', (data) => {
        io.to(data.receiverId).emit('call-answer', {
            answer: data.answer,
            sender: socket.data.username
        });
    });

    socket.on('ice-candidate', (candidate) => {
        if(socket.data.room) socket.to(socket.data.room).emit('ice-candidate', candidate);
    });

    socket.on('end-call', () => {
        if(socket.data.room) socket.to(socket.data.room).emit('end-call');
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const roomKey = socket.data.room;
        if (roomKey) {
            socket.to(roomKey).emit('partner-offline');
            // Cleanup memory
            messageStatus.forEach((status, id) => {
                if (status.roomKey === roomKey) messageStatus.delete(id);
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

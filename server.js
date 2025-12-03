const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    
    socket.on('join-chat', ({ username, roomKey }) => {
        // 1. Get current users in the room (the room name is the password/key)
        const room = io.sockets.adapter.rooms.get(roomKey);
        const numClients = room ? room.size : 0;

        // 2. Enforce 2-person limit
        if (numClients >= 2) {
            socket.emit('error-message', 'This chat is full (2 people max). Try a different password.');
            return;
        }

        // 3. Join the room
        socket.join(roomKey);
        socket.data.username = username;
        socket.data.room = roomKey;

        // Notify the user they joined
        socket.emit('system-message', 'You have joined the secure chat.');
        
        // Notify the other person (if they exist)
        socket.to(roomKey).emit('system-message', `${username} has connected.`);
    });

    socket.on('send-message', (encryptedData) => {
        const roomKey = socket.data.room;
        if (roomKey) {
            // Broadcast the encrypted data to the other person in the room
            socket.to(roomKey).emit('receive-message', {
                user: socket.data.username,
                data: encryptedData
            });
        }
    });

    socket.on('disconnect', () => {
        const roomKey = socket.data.room;
        if (roomKey) {
            socket.to(roomKey).emit('system-message', `${socket.data.username} left the chat.`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

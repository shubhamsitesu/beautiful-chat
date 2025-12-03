document.addEventListener('DOMContentLoaded', () => {
    // --- State ---
    let socket;
    let myUsername = '';
    let currentChatUser = '';
    let currentSessionId = '';
    let sodium;
    let keyPair;
    const chatKeys = new Map(); // sessionId -> sharedSecret

    // --- DOM Elements ---
    const authContainer = document.getElementById('auth-container');
    const appContainer = document.getElementById('app-container');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const onlineUsersDiv = document.getElementById('online-users');
    const chatHeader = document.getElementById('chat-header');
    const messagesContainer = document.getElementById('messages-container');
    const messageInput = document.getElementById('message-input');
    const messageForm = document.getElementById('message-form');
    const typingIndicator = document.getElementById('typing-indicator');
    const typingUserText = document.getElementById('typing-user-text');

    // --- Auth UI ---
    window.showLogin = () => { loginForm.classList.remove('hidden'); registerForm.classList.add('hidden'); };
    window.showRegister = () => { loginForm.classList.add('hidden'); registerForm.classList.remove('hidden'); };
    window.logout = () => location.reload();

    window.handleLogin = async () => {
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        if (res.ok) initSocket(username);
        else alert('Login failed!');
    };

    window.handleRegister = async () => {
        const username = document.getElementById('register-username').value;
        const password = document.getElementById('register-password').value;
        const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        if (res.ok) { showLogin(); alert('Registration successful! Please login.'); }
        else alert('Registration failed!');
    };

    // --- Core App Logic ---
    const initSocket = (username) => {
        myUsername = username;
        socket = io();
        setupSocketListeners();
        initSodium();
        authContainer.classList.add('hidden');
        appContainer.classList.remove('hidden');
    };

    const initSodium = async () => {
        await window.sodium.ready;
        sodium = window.sodium;
        keyPair = sodium.crypto_kx_keypair();
    };

    const setupSocketListeners = () => {
        socket.on('connect', () => {
            const password = document.getElementById('login-password').value;
            socket.emit('authenticate', { username: myUsername, password });
        });

        socket.on('auth-error', (msg) => alert(msg));

        socket.on('user-list-updated', (users) => {
            onlineUsersDiv.innerHTML = users.filter(u => u !== myUsername).map(user => `
                <div class="p-3 bg-white rounded-lg shadow cursor-pointer hover:bg-gray-100" onclick="startChatWith('${user}')">
                    <p class="font-medium">${user}</p>
                </div>
            `).join('');
        });

        socket.on('chat-invitation', ({ from, sessionId }) => {
            if (confirm(`Chat request from ${from}. Accept?`)) {
                socket.emit('accept-chat', { sessionId });
                setActiveChat(from, sessionId);
            }
        });

        socket.on('chat-started', ({ sessionId, with: user }) => setActiveChat(user, sessionId));

        socket.on('new-message', (msg) => {
            if (msg.sender === currentChatUser) {
                const sharedSecret = chatKeys.get(currentSessionId);
                const decryptedText = sodium.to_string(sodium.crypto_secretbox_open_easy(sodium.from_base64(msg.ciphertext), sodium.from_base64(msg.nonce), sharedSecret));
                renderMessage({ sender: msg.sender, text: decryptedText, isMyself: false });
            }
        });

        socket.on('user-typing', ({ user, isTyping }) => {
            if (user === currentChatUser) {
                typingIndicator.classList.toggle('hidden', !isTyping);
                typingUserText.textContent = user;
            }
        });
    };

    window.startChatWith = (user) => {
        socket.emit('start-chat', { targetUser: user });
        chatHeader.innerHTML = `<h3 class="text-lg font-semibold text-gray-800">Waiting for ${user} to accept...</h3>`;
    };

    const setActiveChat = (user, sessionId) => {
        currentChatUser = user;
        currentSessionId = sessionId;
        chatHeader.innerHTML = `<h3 class="text-lg font-semibold text-gray-800">${user}</h3>`;
        messagesContainer.innerHTML = '';
        messageInput.disabled = false;
        messageForm.querySelector('button').disabled = false;
        
        // Derive shared key for this session
        const theirPubKey = sodium.from_base64("placeholder_public_key_from_server"); // In a real app, server would facilitate this key exchange
        const { sharedRx } = sodium.crypto_kx_server_session_keys(keyPair.publicKey, keyPair.privateKey, theirPubKey);
        chatKeys.set(sessionId, sharedRx);
    };

    const renderMessage = ({ sender, text, isMyself }) => {
        const div = document.createElement('div');
        div.className = `flex ${isMyself ? 'justify-end' : 'justify-start'}`;
        div.innerHTML = `
            <div class="max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${isMyself ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-800'}">
                <p>${text}</p>
            </div>
        `;
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };

    // --- Message Sending & Typing Indicator ---
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (!text || !currentSessionId) return;

        const sharedSecret = chatKeys.get(currentSessionId);
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        const ciphertext = sodium.crypto_secretbox_easy(text, nonce, sharedSecret);
        
        socket.emit('send-message', {
            sessionId: currentSessionId,
            encryptedData: { ciphertext: sodium.to_base64(ciphertext), nonce: sodium.to_base64(nonce) }
        });

        renderMessage({ sender: myUsername, text, isMyself: true });
        messageInput.value = '';
        socket.emit('typing-stop', currentSessionId);
    });

    let typingTimeout;
    messageInput.addEventListener('input', () => {
        if (!currentSessionId) return;
        socket.emit('typing-start', currentSessionId);
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => socket.emit('typing-stop', currentSessionId), 1000);
    });
});

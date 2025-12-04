// public/script.js

// --- CRITICAL CONFIGURATION ---
// NOTE: Change this URL to your actual Render Web Service URL
const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; 
const socket = io(RENDER_APP_URL, { transports: ['websocket', 'polling'] }); 

// UI Elements
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');

let myUsername = null; 

// --- UI HELPER FUNCTIONS ---
function addMessage(text, type, user, timestamp, messageId) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    div.setAttribute('data-id', messageId); 

    const date = new Date(timestamp);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const partnerName = myUsername === 'UserA' ? 'UserB' : 'UserA';
    const headerText = user === myUsername ? 'You' : partnerName;

    div.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-text">${text}</div>
        <span class="message-time">${timeString}</span>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // **AUTO-DELETE LOGIC FOR RECEIVED MESSAGES:**
    if (type === 'received') {
        socket.emit('message-viewed-and-delete', messageId);
        
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, 3000); // 3 seconds grace period to read
    }
}

function loadHistory(history) {
    messagesDiv.innerHTML = '';
    history.forEach(msg => {
        const type = msg.user === myUsername ? 'sent' : 'received';
        addMessage(msg.text, type, msg.user, msg.timestamp, msg.id); 
    });
}

// --- LISTENERS ---
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const pass = document.getElementById('password').value;
    socket.emit('authenticate-user', { password: pass });
});


chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('message-input');
    const text = input.value;
    if (!text) return;

    const id = crypto.randomUUID();
    
    // Send message to server
    socket.emit('send-message', { messageId: id, text: text });

    // Display immediately for sender
    addMessage(text, 'sent', myUsername, Date.now(), id);
    input.value = '';
});


// --- SOCKET EVENTS ---
socket.on('auth-success', ({ username, history }) => {
    myUsername = username;
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    
    const partner = username === 'UserA' ? 'UserB' : 'UserA';
    document.getElementById('chat-header').textContent = `Chat with ${partner} (${username})`;
    
    loadHistory(history);
    partnerStatusEl.textContent = 'Connecting...';
});

socket.on('auth-failure', (msg) => {
    document.getElementById('error-msg').textContent = msg;
    // Auto-reload if server session is lost
    if (msg.includes('Refresh')) {
        alert(msg);
        location.reload();
    }
});

socket.on('receive-message', (msg) => {
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id);
});

socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        el.style.transition = 'opacity 0.5s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500); 
    }
});

socket.on('partner-online', (user) => {
    const partnerName = user === myUsername ? 'You' : user;
    partnerStatusEl.textContent = `🟢 ${partnerName} Online`;
    partnerStatusEl.style.color = '#4CAF50';
});

socket.on('partner-offline', (user) => {
    const partnerName = user === myUsername ? 'You' : user;
    partnerStatusEl.textContent = `⚫ ${partnerName} Offline`;
    partnerStatusEl.style.color = '#aaa';
});

const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; 
const socket = io(RENDER_APP_URL);

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

    const headerText = user === myUsername ? 'You' : (myUsername === 'UserA' ? 'UserB' : 'UserA');

    div.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-text">${text}</div>
        <span class="message-time">${timeString}</span>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // **AUTO-DELETE LOGIC FOR RECEIVED MESSAGES:**
    if (type === 'received') {
        // 1. Signal server to remove from chat_history.json (File Delete)
        socket.emit('message-viewed-and-delete', messageId);
        
        // 2. Remove the message from the client screen (Clean Fade-out)
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
    // Load only messages sent by the current user 
    history.forEach(msg => {
        const type = msg.user === myUsername ? 'sent' : 'received';
        if (type === 'sent') {
             addMessage(msg.text, type, msg.user, msg.timestamp, msg.id);
        }
    });
}

// --- LOGIN/AUTHENTICATION (Password Only) ---
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = document.getElementById('password').value;
    
    socket.emit('authenticate-user', { password: pass });
});


// --- CHAT FORM SUBMISSION ---
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('message-input');
    const text = input.value;
    if (!text) return;

    const id = crypto.randomUUID();
    
    socket.emit('send-message', { messageId: id, text: text });

    // Display immediately
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
});

socket.on('auth-failure', (msg) => {
    document.getElementById('error-msg').textContent = msg;
});

socket.on('receive-message', (msg) => {
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id);
});

// Clean delete signal from server (Sender's view cleanup)
socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        // Fade out sent message after partner confirms view
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

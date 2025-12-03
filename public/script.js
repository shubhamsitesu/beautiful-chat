const socket = io();

// DOM Elements
const loginContainer = document.getElementById('login-container');
const chatContainer = document.getElementById('chat-container');
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('message-input');
const messagesDiv = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const partnerStatusEl = document.getElementById('partner-status');
const timerSetting = document.getElementById('timer-setting');
const clearChatBtn = document.getElementById('clear-chat-btn'); // NEW

// Video Elements
const mediaContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const startCallBtn = document.getElementById('start-call-btn');
const endCallBtn = document.getElementById('end-call-btn');
const callNotification = document.getElementById('call-notification'); // NEW
const acceptCallBtn = document.getElementById('accept-call');         // NEW
const declineCallBtn = document.getElementById('decline-call');       // NEW
const callActionsDiv = document.getElementById('call-actions');       // NEW

let myKey = null;
let myUsername = null;
let typingTimeout = null;
let peerConnection = null;
let localStream = null;
const iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- DELETE & CONTEXT MENU STATE ---
let selectedMessageId = null;
let touchStartTime;
let touchTimeout;

// --- CRYPTO FUNCTIONS ---
async function deriveKey(password) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("fixed_salt_for_demo"), iterations: 300000, hash: "SHA-256" },
        keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}

async function encryptMessage(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = enc.encode(text);
    const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, myKey, encoded);
    return { iv: Array.from(iv), content: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptMessage(data) {
    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(data.iv) }, myKey, new Uint8Array(data.content)
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) { return "⚠️ Decryption Failed"; }
}

// --- UI FUNCTIONS ---
function addMessage(text, type, messageId, user = null) {
    const div = document.createElement('div');
    div.classList.add('message', type);
    div.setAttribute('data-id', messageId);

    if (type === 'received' && user) {
        const header = document.createElement('div');
        header.classList.add('message-header');
        header.textContent = user;
        div.appendChild(header);
    }

    const content = document.createElement('span');
    content.textContent = text;
    div.appendChild(content);

    if (type === 'sent') {
        const statusEl = document.createElement('span');
        statusEl.classList.add('status-icon');
        statusEl.innerHTML = '✔️'; // Single Tick
        div.appendChild(statusEl);
    }

    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function updateMessageStatus(id, status) {
    const el = document.querySelector(`.message[data-id="${id}"] .status-icon`);
    if (!el) return;
    if (status === 'delivered') { el.innerHTML = '✔️✔️'; el.style.color = '#999'; }
    if (status === 'read') { el.innerHTML = '✔️✔️'; el.style.color = '#00bcd4'; } // Use accent color
}

function startTimer(messageId, seconds) {
    const el = document.querySelector(`.message[data-id="${messageId}"]`);
    if (!el || el.querySelector('.countdown-timer')) return;

    const timerEl = document.createElement('span');
    timerEl.classList.add('countdown-timer');
    el.appendChild(timerEl);

    let left = seconds;
    const interval = setInterval(() => {
        left--;
        timerEl.textContent = `💣 ${left}s`;
        if (left <= 0) {
            clearInterval(interval);
            el.textContent = "— 💥 Self-Destructed —";
            el.className = "message deleted";
            socket.emit('self-destruct-complete', messageId);
        }
    }, 1000);
}

// --- NEW DELETION & CONTEXT MENU FUNCTIONS ---

function showContextMenu(x, y, isSender) {
    document.querySelectorAll('.context-menu').forEach(m => m.remove()); 

    const menu = document.createElement('div');
    menu.classList.add('context-menu');
    // Adjust position to prevent going off-screen (basic)
    menu.style.left = `${x > window.innerWidth - 200 ? window.innerWidth - 200 : x}px`; 
    menu.style.top = `${y}px`;

    menu.innerHTML += `<button onclick="deleteMessageWrapper('for_me')">Delete for Me</button>`;

    if (isSender) {
        menu.innerHTML += `<button onclick="deleteMessageWrapper('for_everyone')">Delete for Everyone</button>`;
    }

    document.body.appendChild(menu);

    // Hide menu on any other click
    document.addEventListener('click', () => menu.remove(), { once: true });
}

// Global wrapper function for context menu buttons
window.deleteMessageWrapper = (scope) => {
    if (selectedMessageId) {
        // Send the request to the server
        socket.emit('delete-message', { messageId: selectedMessageId, scope: scope });
        selectedMessageId = null;
        document.querySelectorAll('.context-menu').forEach(m => m.remove()); 
    }
}

function handleTouchStart(e) {
    const msgEl = e.target.closest('.message.sent') || e.target.closest('.message.received');
    if (msgEl) {
        touchStartTime = Date.now();
        touchTimeout = setTimeout(() => {
            e.preventDefault(); 
            selectedMessageId = msgEl.getAttribute('data-id');
            showContextMenu(e.touches[0].clientX, e.touches[0].clientY, msgEl.classList.contains('sent'));
        }, 500); // 500ms for long press
    }
}

function handleTouchEnd(e) {
    clearTimeout(touchTimeout);
}

function handleMessageContext(e) {
    const msgEl = e.target.closest('.message');
    if (msgEl) {
        e.preventDefault(); 
        selectedMessageId = msgEl.getAttribute('data-id');
        showContextMenu(e.clientX, e.clientY, msgEl.classList.contains('sent'));
    }
}


// --- EVENT LISTENERS ---
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const user = document.getElementById('username').value;
    const pass = document.getElementById('password').value;
    if (!user || !pass) return;

    myUsername = user;
    myKey = await deriveKey(pass);
    
    document.title = `Chat - ${user}`;
    socket.emit('join-chat', { username: user, roomKey: pass });
    
    loginContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');

    // Setup listeners for context menu
    messagesDiv.addEventListener('contextmenu', handleMessageContext);
    messagesDiv.addEventListener('touchstart', handleTouchStart, { passive: false });
    messagesDiv.addEventListener('touchend', handleTouchEnd); 
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = msgInput.value;
    if (!text) return;

    const id = crypto.randomUUID();
    const encrypted = await encryptMessage(text);
    const timer = parseInt(timerSetting.value);

    socket.emit('send-message', { encryptedData: encrypted, messageId: id, timer: timer }, (isDelivered) => {
        if (isDelivered) updateMessageStatus(id, 'delivered');
    });

    addMessage(text, 'sent', id, myUsername);
    msgInput.value = '';
});

msgInput.addEventListener('input', () => {
    socket.emit('typing');
});

clearChatBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to clear this entire chat history? This cannot be undone.")) {
        socket.emit('clear-chat-room');
    }
});


// --- SOCKET EVENTS ---
socket.on('receive-message', async ({ user, data, messageId, timer }) => {
    typingIndicator.textContent = '';
    const text = await decryptMessage(data);
    addMessage(text, 'received', messageId, user);
    socket.emit('message-viewed', messageId);
    if (timer > 0) startTimer(messageId, timer);
});

socket.on('message-read', (id) => updateMessageStatus(id, 'read'));

// Handler for the SENDER deleting a message (local or for everyone)
socket.on('message-deleted-local', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el) {
        el.textContent = "— You deleted this message —";
        el.className = "message deleted";
    }
});

// Handler for the PARTNER deleting a message (for everyone or self-destruct)
socket.on('message-deleted-partner', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el) {
        el.textContent = "— Partner deleted message —";
        el.className = "message deleted";
    }
});

// Handler for clearing the entire chat
socket.on('chat-cleared-local', () => {
    messagesDiv.innerHTML = '';
    const div = document.createElement('div');
    div.classList.add('system-msg');
    div.textContent = 'Chat history cleared by user.';
    messagesDiv.appendChild(div);
});

socket.on('is-typing', (user) => {
    typingIndicator.textContent = `${user} is typing...`;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { typingIndicator.textContent = ''; }, 2000);
});

socket.on('partner-online', (user) => {
    partnerStatusEl.textContent = `🟢 ${user} Online`;
    partnerStatusEl.style.color = '#a8e895';
});

socket.on('partner-offline', () => {
    partnerStatusEl.textContent = '⚫ Offline';
    partnerStatusEl.style.color = '#b3e5fc';
});

socket.on('system-message', (msg) => {
    const div = document.createElement('div');
    div.classList.add('system-msg');
    div.textContent = msg;
    messagesDiv.appendChild(div);
});

socket.on('error-message', (msg) => alert(msg));

// --- WEBRTC VIDEO CALL LOGIC ---
async function setupMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        return true;
    } catch(e) { 
        alert("Camera Access Denied or not available. Cannot start call."); 
        return false; 
    }
}

function createPeer(isCaller, targetId) {
    peerConnection = new RTCPeerConnection(iceServers);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = e => {
        remoteVideo.srcObject = e.streams[0];
        mediaContainer.classList.remove('hidden');
    };
    peerConnection.onicecandidate = e => {
        if(e.candidate) socket.emit('ice-candidate', { candidate: e.candidate, receiverId: targetId });
    };

    if(isCaller) {
        peerConnection.onnegotiationneeded = async () => {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('call-offer', offer);
        };
    }
}

// Function to reset all call UI elements
function resetCallUI() {
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(t => t.stop());
    peerConnection = null;
    localStream = null;
    mediaContainer.classList.add('hidden');
    callNotification.classList.add('hidden');
    startCallBtn.classList.remove('hidden');
    endCallBtn.classList.add('hidden');
    callActionsDiv.classList.remove('hidden');
}


startCallBtn.addEventListener('click', async () => {
    if(await setupMedia()) {
        createPeer(true, null);
        callActionsDiv.classList.add('hidden'); // Hide all actions
        endCallBtn.classList.remove('hidden');
    }
});

endCallBtn.addEventListener('click', () => {
    resetCallUI();
    socket.emit('end-call');
});

// ACCEPT CALL BUTTON from notification
acceptCallBtn.addEventListener('click', async () => {
    const { offer, senderId } = acceptCallBtn.callData; // Data stored temporarily on the button
    
    if(await setupMedia()) {
        createPeer(false, senderId);
        await peerConnection.setRemoteDescription(offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('call-answer', { answer, receiverId: senderId });
        
        callNotification.classList.add('hidden');
        mediaContainer.classList.remove('hidden');
        startCallBtn.classList.add('hidden');
        endCallBtn.classList.remove('hidden');
    } else {
        // If media fails, decline the call
        socket.emit('end-call');
        resetCallUI();
    }
});

// DECLINE CALL BUTTON from notification
declineCallBtn.addEventListener('click', () => {
    socket.emit('end-call'); // Send a signal to decline (will trigger end-call on both sides)
    resetCallUI();
});


// INCOMING CALL OFFER (Shows Notification Popup)
socket.on('call-offer', async ({offer, sender, senderId}) => {
    callActionsDiv.classList.add('hidden'); // Hide original buttons

    // Store call data on the button element for use in the accept handler
    acceptCallBtn.callData = { offer, senderId }; 
    
    document.getElementById('caller-name').textContent = sender;
    callNotification.classList.remove('hidden');
});

socket.on('call-answer', async ({answer}) => {
    if(peerConnection) await peerConnection.setRemoteDescription(answer);
});

socket.on('ice-candidate', async (candidate) => {
    if(peerConnection) await peerConnection.addIceCandidate(candidate);
});

socket.on('end-call', () => {
    // Alert removed for cleaner UX
    resetCallUI();
});

// public/script.js

// UPDATE YOUR SERVER URL HERE
const RENDER_APP_URL = "https://beautiful-chat.onrender.com"; 
// reconnectionAttempts: 5, reconnectionDelay: 1000 - ये सेटिंग्स ऑटो-रीकनेक्ट को मैनेज करेंगी
const socket = io(RENDER_APP_URL, { 
    transports: ['websocket', 'polling'], 
    reconnectionAttempts: 5, 
    reconnectionDelay: 1000 
}); 

// References to HTML elements (HTML तत्वों के संदर्भ)
const loginForm = document.getElementById('login-form');
const chatForm = document.getElementById('chat-form');
const messagesDiv = document.getElementById('messages');
const partnerStatusEl = document.getElementById('partner-status');
const messageInput = document.getElementById('message-input');
const deleteTimerSelect = document.getElementById('delete-timer'); 
const typingIndicatorEl = document.getElementById('typing-indicator'); 
const connectionStatusEl = document.getElementById('connection-status');

const KEY_STORE_NAME = 'chat_e2ee_key_persistence'; 

let myUsername = null; 
let myKeyPair = null;     
let sharedSecret = null;  
let isE2EEReady = false;  
let isTyping = false;
let timeout = undefined;
let currentSelfDestructTime = 10000;
let messageQueue = []; // FIX: डिस्कनेक्ट होने पर मैसेज यहाँ स्टोर होंगे

// --- E2EE CRYPTO FUNCTIONS ---
async function generateKeyPair() {
    return window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
    );
}

async function deriveSharedSecret(partnerPublicKeyJwk) {
    try {
        const partnerPublicKey = await window.crypto.subtle.importKey(
            "jwk", partnerPublicKeyJwk, { name: "ECDH", namedCurve: "P-256" }, false, []
        );
        return await window.crypto.subtle.deriveKey(
            { name: "ECDH", public: partnerPublicKey },
            myKeyPair.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
    } catch(e) { return null; }
}

const bufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
};

async function encryptE2EE(text) {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12)); 
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, sharedSecret, enc.encode(text)
    );
    return { text: bufferToBase64(ciphertext), iv: bufferToBase64(iv.buffer) };
}

async function decryptE2EE(b64Cipher, b64Iv) {
    try {
        const iv = Uint8Array.from(atob(b64Iv), c => c.charCodeAt(0));
        const ciphertext = Uint8Array.from(atob(b64Cipher), c => c.charCodeAt(0));
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv }, sharedSecret, ciphertext
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) { return "🔒 Encrypted (Key Lost)"; }
}

// --- PERSISTENCE FUNCTIONS ---

async function saveState() {
    if (myUsername && myKeyPair) {
        // Private key को लोकल स्टोरेज में सेव करें
        const privateKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.privateKey);
        const state = { username: myUsername, privateKey: privateKeyJwk };
        localStorage.setItem(KEY_STORE_NAME, JSON.stringify(state));
    }
}

async function loadState() {
    const storedState = localStorage.getItem(KEY_STORE_NAME);
    if (!storedState) return false;
    try {
        const state = JSON.parse(storedState);
        // प्राइवेट कुंजी को स्टोरेज से इंपोर्ट करें
        const privateKey = await window.crypto.subtle.importKey(
            "jwk", state.privateKey, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]
        );
        myUsername = state.username;
        myKeyPair = { privateKey: privateKey }; 
        return true;
    } catch (e) {
        console.error("लोकल स्टोरेज से कुंजी लोड करने में विफल:", e);
        localStorage.removeItem(KEY_STORE_NAME);
        return false;
    }
}

function removeState() {
    localStorage.removeItem(KEY_STORE_NAME);
    myUsername = null;
    myKeyPair = null;
}


// --- UI HELPER FUNCTIONS ---
async function addMessage(text, type, user, timestamp, messageId, isE2EE = false, iv = null, timerDuration = 0, isQueued = false) {
    let displayText = text;
    if (isE2EE && type === 'received') {
        if (sharedSecret && iv) {
             displayText = await decryptE2EE(text, iv);
        }
        else {
             // Shared Secret खो जाने पर, पुराने E2EE मैसेज Key Lost दिखेंगे
             displayText = "🔒 Encrypted (Key Lost)";
        }
    }
    
    // यदि मैसेज क्यू में है, तो उसे एक विशेष रंग दें
    const queueStyle = isQueued ? 'opacity: 0.6; font-style: italic;' : '';

    const messageType = (user === myUsername) ? 'sent' : 'received';
    const div = document.createElement('div');
    div.classList.add('message', messageType);
    div.setAttribute('data-id', messageId); 
    if (isQueued) div.classList.add('queued');

    const date = new Date(timestamp);
    const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const partnerName = myUsername === 'UserA' ? 'UserB' : 'UserA';
    const headerText = user === myUsername ? 'आप' : partnerName; 
    const lockIcon = isE2EE ? '🔒 ' : '';
    const timerIcon = timerDuration > 0 ? ` ⏱️ ${timerDuration / 1000}s` : '';
    const queuedText = isQueued ? ' (Queueing...)' : '';

    div.innerHTML = `
        <div class="message-header">${headerText}</div>
        <div class="message-text" style="${isE2EE ? 'color:#2e7d32; font-weight:500;' : ''} ${queueStyle}">${lockIcon}${displayText}${timerIcon}${queuedText}</div>
        <span class="message-time">${timeString}</span>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // Auto-Delete based on server Timer
    if (timerDuration > 0 && messageType === 'received') { 
        socket.emit('message-viewed-and-delete', messageId);
        setTimeout(() => {
            if (div.parentNode) {
                div.style.transition = 'opacity 0.5s';
                div.style.opacity = '0';
                setTimeout(() => div.remove(), 500); 
            }
        }, timerDuration); 
    }
    
    return div; // DOM element वापस करें
}

function loadHistory(history) {
    messagesDiv.innerHTML = '';
    history.forEach(msg => {
        addMessage(msg.text, null, msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv, msg.timerDuration || 0); 
    });
}

// --- MESSAGE QUEUE PROCESSING ---

async function processQueue() {
    if (messageQueue.length === 0) return;
    
    connectionStatusEl.textContent = `क्यू में ${messageQueue.length} मैसेज भेज रहा है...`;
    connectionStatusEl.className = 'text-blue-600 font-bold';

    // एक-एक करके क्यू से मैसेज भेजें
    while (messageQueue.length > 0) {
        const { rawText, id, tempDiv } = messageQueue.shift();
        
        let payload = { messageId: id, text: rawText, isE2EE: false, timerDuration: currentSelfDestructTime };

        if (isE2EEReady && sharedSecret) {
            const encryptedData = await encryptE2EE(rawText);
            payload.text = encryptedData.text;
            payload.iv = encryptedData.iv;
            payload.isE2EE = true;
        } 
        
        socket.emit('send-message', payload);
        
        // UI को अपडेट करें (क्यू स्थिति हटाएँ)
        if (tempDiv) {
             tempDiv.classList.remove('queued');
             const textEl = tempDiv.querySelector('.message-text');
             if(textEl) textEl.innerHTML = textEl.innerHTML.replace(' (Queueing...)', '');
        }

        // भेजने के बीच 50ms प्रतीक्षा करें (नेटवर्क फ्लड से बचने के लिए)
        await new Promise(resolve => setTimeout(resolve, 50)); 
    }
    
    connectionStatusEl.textContent = "ऑनलाइन";
    connectionStatusEl.className = 'text-green-600 font-bold';
}


// --- SOCKET CONNECTION HANDLERS ---

socket.on('connect', async () => {
    connectionStatusEl.textContent = "ऑनलाइन";
    connectionStatusEl.className = 'text-green-600 font-bold';
    
    // यदि उपयोगकर्ता पहले से ही localStorage से प्रमाणित है, तो चुपचाप पुनः प्रमाणित करने का प्रयास करें
    if (myUsername && myKeyPair && myKeyPair.privateKey) {
         console.log(`संग्रहीत उपयोगकर्ता के साथ पुनः कनेक्ट हो रहा है: ${myUsername}`);
         
         // Public Key को private key से प्राप्त करने का प्रयास (E2EE के लिए आवश्यक)
         if (!myKeyPair.publicKey) {
             try {
                // एक नया कीपेयर बनाएं (जिसमें पब्लिक की शामिल हो)
                const tempKeyPair = await window.crypto.subtle.generateKey(
                    { name: "ECDH", namedCurve: "P-256" },
                    true,
                    ["deriveKey", "deriveBits"]
                );
                myKeyPair.publicKey = tempKeyPair.publicKey;
            } catch(e) {
                console.error("पुनःकनेक्शन पर पब्लिक कुंजी बनाने में विफल:", e);
                // गंभीर त्रुटि: लॉगिन विफल होगा
            }
         }
         
         socket.emit('authenticate-user', { storedUsername: myUsername });
    }
    
    // कनेक्शन स्थापित होने पर, सभी क्यू मैसेज भेजें
    if (myUsername) {
        await processQueue();
    }
});

socket.on('disconnect', (reason) => {
    connectionStatusEl.textContent = `डिस्कनेक्ट हुआ (${reason})`;
    connectionStatusEl.className = 'text-red-600 font-bold';
    
    // FIX FOR THROTTLING: फोर्स Socket.IO को तुरंत रीकनेक्ट करने के लिए कहें 
    // ताकि ब्राउज़र थ्रॉटलिंग को ओवरराइड किया जा सके।
    if (reason !== 'io client disconnect' && myUsername) { 
        console.log("Forcing socket reconnect due to disconnect:", reason);
        socket.connect(); 
    }
});

socket.on('connect_error', (err) => {
    console.error("कनेक्शन त्रुटि:", err.message);
    connectionStatusEl.textContent = "कनेक्शन त्रुटि";
    connectionStatusEl.className = 'text-yellow-600 font-bold';
});

// --- LISTENERS ---

messageInput.addEventListener('input', () => {
    if (!isTyping) { isTyping = true; socket.emit('typing'); }
    clearTimeout(timeout);
    timeout = setTimeout(() => { isTyping = false; socket.emit('stop-typing'); }, 1000); 
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    const pass = document.getElementById('password').value;
    
    myKeyPair = await generateKeyPair();
    
    removeState(); 

    socket.emit('authenticate-user', { password: pass });
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawText = messageInput.value;
    if (!rawText) return;
    
    const id = crypto.randomUUID();

    if (!socket.connected) {
        // FIX: डिस्कनेक्ट होने पर मैसेज को क्यू में डालें
        const tempDiv = await addMessage(rawText, 'sent', myUsername, Date.now(), id, isE2EEReady, null, currentSelfDestructTime, true);
        messageQueue.push({ rawText, id, tempDiv });
        messageInput.value = '';
        
        connectionStatusEl.textContent = "पुनः कनेक्ट हो रहा है...";
        connectionStatusEl.className = 'text-yellow-600 font-bold';
        socket.connect(); 
        
        return;
    }

    // यदि कनेक्टेड है, तो तुरंत भेजें
    let payload = { messageId: id, text: rawText, isE2EE: false, timerDuration: currentSelfDestructTime };

    if (isE2EEReady && sharedSecret) {
        const encryptedData = await encryptE2EE(rawText);
        payload.text = encryptedData.text;
        payload.iv = encryptedData.iv;
        payload.isE2EE = true;
        addMessage(rawText, 'sent', myUsername, Date.now(), id, true, null, currentSelfDestructTime);
    } else {
        addMessage(rawText, 'sent', myUsername, Date.now(), id, false, null, currentSelfDestructTime);
    }
    
    socket.emit('send-message', payload);
    messageInput.value = '';
    
    clearTimeout(timeout);
    isTyping = false;
    socket.emit('stop-typing');
});

// --- SOCKET EVENTS ---
socket.on('auth-success', async ({ username, history, selfDestructTime, isRelogin }) => {
    myUsername = username;
    currentSelfDestructTime = selfDestructTime;
    if (deleteTimerSelect) deleteTimerSelect.value = selfDestructTime.toString();
    
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    document.getElementById('chat-header').textContent = `चैट: ${username === 'UserA' ? 'UserB' : 'UserA'} (${username})`;
    
    if (!isRelogin) {
        await saveState(); 
    }
    
    loadHistory(history);
    
    // पब्लिक कुंजी निर्यात करें और एक्सचेंज शुरू करें
    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
    socket.emit('exchange-key', { key: publicKeyJwk });
});

socket.on('exchange-key', async (data) => {
    if (!myKeyPair.publicKey) {
        console.error("पब्लिक कुंजी अनुपलब्ध है। E2EE विफल।");
        return;
    }
    
    sharedSecret = await deriveSharedSecret(data.key);
    
    if (sharedSecret) {
        isE2EEReady = true;
        partnerStatusEl.textContent = "🔒 सुरक्षित E2EE कनेक्टेड";
        partnerStatusEl.style.color = "#2e7d32"; 
        
        // सुनिश्चित करें कि मेरी पब्लिक कुंजी पार्टनर को भेजी गई है 
        if (data.from !== myUsername && !isE2EEReady) {
             const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
             socket.emit('exchange-key', { key: publicKeyJwk });
        }
    }
});

socket.on('partner-online', async (user) => {
    // पार्टनर ऑनलाइन: तुरंत E2EE स्थापित करने का प्रयास करें
    if (myKeyPair && myKeyPair.publicKey) {
        const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey);
        socket.emit('exchange-key', { key: publicKeyJwk });
    }
});

socket.on('partner-offline', (user) => {
    const partnerName = user === 'UserA' ? 'UserB' : 'UserA';
    partnerStatusEl.textContent = `⚫ ${partnerName} ऑफ़लाइन`;
    partnerStatusEl.style.color = '#aaa';
    isE2EEReady = false;
    sharedSecret = null; 
    typingIndicatorEl.textContent = '';
});

// --- INITIALIZATION ---
window.onload = async () => {
    const stateLoaded = await loadState();
    if (stateLoaded) {
        // पब्लिक की को private key से प्राप्त करें
        try {
            const tempKeyPair = await window.crypto.subtle.generateKey(
                { name: "ECDH", namedCurve: "P-256" },
                true,
                ["deriveKey", "deriveBits"]
            );
            myKeyPair.publicKey = tempKeyPair.publicKey;
        } catch(e) {
            console.error("पब्लिक कुंजी बनाने में विफल:", e);
            removeState(); 
            location.reload();
            return;
        }

        // socket के कनेक्ट होने की प्रतीक्षा करें
        document.getElementById('login-container').classList.add('hidden');
        document.getElementById('chat-container').classList.remove('hidden');
        document.getElementById('chat-header').textContent = `चैट: (${myUsername} के रूप में लॉगिन कर रहा है...)`;
        partnerStatusEl.textContent = "कनेक्ट हो रहा है...";
        
    } else {
        // यदि कोई स्टेट नहीं मिला, तो लॉगिन फ़ॉर्म दिखाएं
        document.getElementById('login-container').classList.remove('hidden');
        document.getElementById('chat-container').classList.add('hidden');
    }
};

socket.on('sync-self-destruct-time', (newTime) => {
    currentSelfDestructTime = newTime;
    if (deleteTimerSelect) deleteTimerSelect.value = newTime.toString();
});

socket.on('receive-message', (msg) => {
    typingIndicatorEl.textContent = '';
    addMessage(msg.text, 'received', msg.user, msg.timestamp, msg.id, msg.isE2EE, msg.iv, msg.timerDuration);
});

socket.on('partner-typing', (user) => {
    if (user !== myUsername) {
        const partnerName = myUsername === 'UserA' ? 'UserB' : 'UserA';
        typingIndicatorEl.textContent = `${partnerName} टाइप कर रहा है...`;
    }
});

socket.on('partner-stop-typing', (user) => {
    if (user !== myUsername) typingIndicatorEl.textContent = '';
});

socket.on('auth-failure', (msg) => {
    if (msg.includes('Room Full')) {
        document.getElementById('error-msg').textContent = msg;
    } else {
        document.getElementById('error-msg').textContent = "लॉगिन विफल: " + msg;
        removeState(); 
        document.getElementById('login-container').classList.remove('hidden');
        document.getElementById('chat-container').classList.add('hidden');
    }
});

socket.on('message-autodeleted-clean', (id) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el && el.classList.contains('sent')) {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500); 
    }
});

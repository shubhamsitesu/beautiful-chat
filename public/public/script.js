// Wait for the entire HTML document to be loaded before running any JavaScript
document.addEventListener('DOMContentLoaded', () => {

    // --- DOM Elements ---
    // Get references to all the HTML elements we need to interact with
    const loginOverlay = document.getElementById('login-overlay');
    const loginForm = document.getElementById('login-form');
    const usernameInput = document.getElementById('username-input');
    const chatApp = document.getElementById('chat-app');
    const targetUserInput = document.getElementById('target-user-input');
    const messagesContainer = document.getElementById('messages-container');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const chatWithHeader = document.getElementById('chat-with');

    // --- State ---
    // Variables to keep track of the application's current state
    let socket; // The socket.io connection to the server
    let myUserId = ''; // The current user's username
    let targetUserId = ''; // The username of the person we are chatting with
    let sodium; // The libsodium library object for encryption
    let keyPair; // The current user's public/private key pair for E2EE
    // A Map to store the shared secret for each user we chat with
    // Format: Map { 'bob' => Uint8Array(...), 'alice' => Uint8Array(...) }
    const sharedSecrets = new Map();

    // --- E2EE Functions ---
    // These functions handle all the encryption and decryption logic

    // Initialize the sodium library and generate a new key pair for the user
    const initSodium = async () => {
        // Wait for the sodium library to be fully loaded and ready
        await window.sodium.ready;
        sodium = window.sodium;
        // Generate a new key pair for key exchange (X25519)
        keyPair = sodium.crypto_kx_keypair();
        console.log('🔐 E2EE Initialized and key pair generated.');
    };

    // Encrypt a message using a shared secret
    const encryptMessage = (message, sharedSecret) => {
        // Generate a random nonce (number used once) for each encryption
        const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
        // Encrypt the message using the shared secret and the nonce
        const ciphertext = sodium.crypto_secretbox_easy(message, nonce, sharedSecret);
        // Return the encrypted data and the nonce, both encoded in Base64 for safe transport
        return { ciphertext: sodium.to_base64(ciphertext), nonce: sodium.to_base64(nonce) };
    };

    // Decrypt a message using a shared secret
    const decryptMessage = (encryptedData, sharedSecret) => {
        try {
            // Decode the ciphertext and nonce from Base64
            const ciphertext = sodium.from_base64(encryptedData.ciphertext);
            const nonce = sodium.from_base64(encryptedData.nonce);
            // Decrypt the message
            const decryptedBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, sharedSecret);
            // Convert the decrypted bytes back to a string and return it
            return sodium.to_string(decryptedBytes);
        } catch (e) {
            // If decryption fails (e.g., wrong key), log an error and return a placeholder
            console.error("Decryption failed!", e);
            return "[Decryption Error]";
        }
    };

    // Derive a shared secret from our private key and their public key
    const deriveSharedKey = (theirPublicKeyB64) => {
        // Decode their public key from Base64
        const theirPublicKey = sodium.from_base64(theirPublicKeyB64);
        // Perform the key exchange operation to get a shared secret
        const { sharedRx } = sodium.crypto_kx_client_session_keys(
            keyPair.publicKey, keyPair.privateKey, theirPublicKey
        );
        return sharedRx; // This is the shared secret key
    };
    
    // --- UI Functions ---
    // Functions that update the user interface

    // Display a new message in the chat window
    const renderMessage = (msg) => {
        // Create the main message container
        const messageDiv = document.createElement('div');
        // Add 'sent' or 'received' class for styling
        messageDiv.classList.add('message', msg.senderId === myUserId ? 'sent' : 'received');
        
        // Create the message bubble
        const bubble = document.createElement('div');
        bubble.classList.add('message-bubble');
        bubble.textContent = msg.text;

        // Create the info line (showing sender's name)
        const info = document.createElement('div');
        info.classList.add('message-info');
        info.textContent = msg.senderId;

        // Assemble the message element and add it to the container
        messageDiv.appendChild(bubble);
        messageDiv.appendChild(info);
        messagesContainer.appendChild(messageDiv);

        // Automatically scroll to the bottom to show the new message
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };

    // Enable the message input field and send button
    const enableChat = () => {
        messageInput.disabled = false;
        sendButton.disabled = false;
    };

    // --- Event Listeners ---
    // Functions that run when the user interacts with the page

    // Handle the login form submission
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault(); // Prevent the form from reloading the page
        myUserId = usernameInput.value.trim();
        if (myUserId) {
            // Connect to the server using socket.io
            socket = io();
            setupSocketListeners(); // Set up all the socket event listeners
            // Hide the login overlay and show the chat app
            loginOverlay.style.opacity = '0';
            setTimeout(() => {
                loginOverlay.classList.add('hidden');
                chatApp.classList.remove('hidden');
            }, 300);
        }
    });

    // Handle changing the target user in the input field
    targetUserInput.addEventListener('change', (e) => {
        targetUserId = e.target.value.trim();
        if (targetUserId) {
            chatWithHeader.textContent = `Chatting with ${targetUserId}`;
            // Ask the server for the public key of the user we want to chat with
            socket.emit('getPublicKey', targetUserId);
        }
    });

    // Handle the message form submission
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (text && targetUserId) {
            // Get the shared secret for the target user
            const sharedSecret = sharedSecrets.get(targetUserId);
            if (sharedSecret) {
                // Encrypt the message
                const encrypted = encryptMessage(text, sharedSecret);
                // Send the encrypted message to the server
                socket.emit('sendMessage', { receiverId: targetUserId, ...encrypted });
                // Display the message in our own chat window immediately
                renderMessage({ senderId: myUserId, text });
                messageInput.value = ''; // Clear the input field
            } else {
                alert("E2EE not yet established with this user. Please wait.");
            }
        }
    });

    // --- Socket Listeners ---
    // Functions that handle messages received from the server

    const setupSocketListeners = () => {
        // When the connection to the server is established
        socket.on('connect', () => {
            console.log('🟢 Connected to server!');
            // Register our username with the server
            socket.emit('register-user', myUserId);
            // Initialize E2EE and then register our public key
            initSodium().then(() => {
                const pubKeyB64 = sodium.to_base64(keyPair.publicKey);
                socket.emit('registerPublicKey', { publicKey: pubKeyB64 });
            });
        });

        // When we receive a public key from the server
        socket.on('publicKey', ({ userId, publicKey }) => {
            // Check if this is the key for the user we want to chat with
            if (userId === targetUserId) {
                console.log(`🔑 Received public key for ${userId}`);
                // Derive the shared secret using their public key and our private key
                const sharedSecret = deriveSharedKey(publicKey);
                // Store the shared secret for later use
                sharedSecrets.set(userId, sharedSecret);
                // Enable the chat input now that E2EE is established
                enableChat();
                console.log('✅ E2EE established.');
            }
        });

        // When we receive a new message from the server
        socket.on('newMessage', (msg) => {
            // Only decrypt and display the message if it's from the user we're currently chatting with
            if (msg.senderId === targetUserId) {
                const sharedSecret = sharedSecrets.get(msg.senderId);
                if (sharedSecret) {
                    // Decrypt the message
                    const decryptedText = decryptMessage(msg, sharedSecret);
                    // Display the decrypted message
                    renderMessage({ senderId: msg.senderId, text: decryptedText });
                }
            }
        });
    };
});

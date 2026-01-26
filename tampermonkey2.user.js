// ==UserScript==
// @name         Messenger Conversation Extractor (Fixed)
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Extract messages from the OPEN conversation only (not sidebar)
// @author       You
// @match        https://www.messenger.com/*
// @match        https://www.facebook.com/messages/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    console.log('🚀 Messenger Message Extractor v3.1 (Open Conversation Only)');

    function extractMessages() {
        console.clear();
        console.log('═'.repeat(70));
        console.log('📨 MESSAGES FROM OPEN CONVERSATION');
        console.log('═'.repeat(70));

        const messages = [];

        // Strategy: Find the main conversation area, excluding the sidebar
        // The sidebar usually has data-virtualized or is in a scrollable list
        // The actual conversation is in the main content area

        let conversationArea = null;

        // Try to find the actual message thread (not the sidebar list)
        // Look for the container that has the chat messages
        const mainElement = document.querySelector('[role="main"]');

        if (!mainElement) {
            console.warn('⚠️ No main area found.');
            return messages;
        }

        // Within main, find the message thread container
        // This should exclude the sidebar which is typically outside [role="main"]
        // or in a separate section

        // Look for elements that indicate actual messages (not previews)
        // Message threads typically have specific containers
        const possibleContainers = [
            mainElement.querySelector('[data-scope="messages_table"]'),
            mainElement.querySelector('[role="grid"]'),
            mainElement
        ];

        for (let container of possibleContainers) {
            if (container) {
                const rows = container.querySelectorAll('[role="row"]');
                if (rows.length > 0) {
                    conversationArea = container;
                    console.log(`✓ Found conversation area with ${rows.length} rows`);
                    break;
                }
            }
        }

        if (!conversationArea) {
            console.warn('⚠️ Could not find the open conversation area.');
            console.log('💡 Make sure a conversation is open (not just selected)');
            return messages;
        }

        // Now get rows ONLY from the conversation area (not from sidebar)
        const messageRows = conversationArea.querySelectorAll('[role="row"]');
        console.log(`Processing ${messageRows.length} message rows...
`);

        messageRows.forEach((row, rowIndex) => {
            // Skip if this row is part of the sidebar (has certain attributes)
            if (row.closest('[data-virtualized="false"]') &&
                row.querySelector('a[href*="/t/"]')) {
                // This is likely a sidebar conversation preview, skip it
                return;
            }

            // Find sender name
            let sender = null;

            // Look for h4 or h5 that contains the sender name
            const headers = row.querySelectorAll('h4, h5');
            for (let header of headers) {
                const text = header.textContent.trim();
                if (text &&
                    !text.includes('sent') &&
                    !text.includes('Active now') &&
                    !text.includes('Unread') &&
                    text.length < 50) {
                    sender = text;
                    break;
                }
            }

            // Check if it's from "You"
            const rowText = row.textContent;
            if (rowText.includes('You sent') || rowText.includes('You:')) {
                sender = 'You';
            }

            // Extract message text
            // Look for message bubbles - they typically have specific classes
            const messageBubbles = row.querySelectorAll(
                'div[dir="auto"][class*="x1gslohp"], ' +
                'span[dir="auto"][class*="x1lliihq"]'
            );

            messageBubbles.forEach(bubble => {
                const text = bubble.textContent.trim();

                // Filter out noise
                if (text &&
                    text.length > 1 &&
                    !text.match(/^(Enter|Active now|Unread|sent|Reacted|·)$/i) &&
                    !text.match(/^\d+[hms]$/) &&
                    !text.match(/^[\d:]+[ap]m$/i) &&
                    text !== sender) {

                    // Check for duplicates
                    const key = `${sender}:${text}`;
                    const isDupe = messages.some(m =>
                        `${m.sender}:${m.message}` === key
                    );

                    if (!isDupe) {
                        messages.push({
                            index: messages.length + 1,
                            sender: sender || 'Unknown',
                            message: text
                        });
                    }
                }
            });
        });

        // Display results
        console.log('─'.repeat(70));

        if (messages.length === 0) {
            console.log('❌ No messages found in the open conversation.');
            console.log('💡 Tips:');
            console.log('   - Make sure a conversation is fully open (not just selected)');
            console.log('   - Scroll up to load older messages if needed');
            console.log('   - Try typing extractMessages() again after scrolling');
        } else {
            messages.forEach((msg) => {
                console.log(`
[${msg.index}] ${msg.sender}:`);
                console.log(`   ${msg.message}`);
                console.log('─'.repeat(70));
            });

            console.log(`
✅ Successfully extracted ${messages.length} messages`);
        }

        console.log('═'.repeat(70));

        return messages;
    }

    // Auto-run after page loads
    window.addEventListener('load', function() {
        setTimeout(() => {
            console.log('⏳ Loading...');
            setTimeout(extractMessages, 4000);
        }, 1000);
    });

    // Manual trigger
    window.extractMessages = extractMessages;
    console.log('💡 Type "extractMessages()" to extract messages from open conversation');

    // Monitor for new messages
    const observer = new MutationObserver(function(mutations) {
        let hasNewMessage = false;

        mutations.forEach(function(mutation) {
            if (mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1 &&
                        node.getAttribute &&
                        node.getAttribute('role') === 'row' &&
                        !node.closest('[data-virtualized="false"]')) {
                        hasNewMessage = true;
                    }
                });
            }
        });

        if (hasNewMessage) {
            console.log('🔔 New message detected in conversation!');
        }
    });

    // Start observing
    setTimeout(() => {
        const mainArea = document.querySelector('[role="main"]');
        if (mainArea) {
            observer.observe(mainArea, {
                childList: true,
                subtree: true
            });
            console.log('👀 Monitoring conversation for new messages...');
        }
    }, 5000);

})();
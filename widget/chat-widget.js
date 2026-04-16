(function () {
  'use strict';

  // --- Configuration -----------------------------------------------------------

  var scriptTag = document.currentScript;
  var site = scriptTag.getAttribute('data-site') || 'ats';

  // Derive API URL from the script src, or use data-api override
  var apiUrl = scriptTag.getAttribute('data-api');
  if (!apiUrl) {
    var src = scriptTag.getAttribute('src') || '';
    var match = src.match(/^(https?:\/\/[^/]+)/);
    apiUrl = match ? match[1] : '';
  }

  var SITES = {
    ats: {
      color: '#1a56db',
      name: 'ATS Norway',
      welcome: 'Hei! Hvordan kan jeg hjelpe deg?',
    },
    lbs: {
      color: '#15803d',
      name: 'Landbrukssalg',
      welcome: 'Hei! Hvordan kan jeg hjelpe deg?',
    },
  };

  var config = SITES[site] || SITES.ats;

  // --- Session ----------------------------------------------------------------

  var SESSION_KEY = 'nanoclaw_chat_session_' + site;

  function getSessionId() {
    var id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  // --- State ------------------------------------------------------------------

  var isOpen = false;
  var hasUnread = false;
  var messages = [];
  var isWaiting = false;

  // --- DOM Creation -----------------------------------------------------------

  var container = document.createElement('div');
  container.id = 'nanoclaw-chat-widget';

  var shadow = container.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = ''
    + '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }'
    + ':host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; font-size: 14px; line-height: 1.5; color: #1f2937; }'

    // Bubble
    + '.nc-bubble { position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px; border-radius: 50%; background: ' + config.color + '; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: transform 0.2s ease, box-shadow 0.2s ease; z-index: 2147483646; border: none; }'
    + '.nc-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.2); }'
    + '.nc-bubble svg { width: 28px; height: 28px; fill: white; }'
    + '.nc-unread { position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; background: #ef4444; border-radius: 50%; border: 2px solid white; display: none; }'
    + '.nc-unread.show { display: block; }'

    // Panel
    + '.nc-panel { position: fixed; bottom: 90px; right: 20px; width: 400px; height: 500px; background: white; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; z-index: 2147483647; transform: translateY(20px) scale(0.95); opacity: 0; pointer-events: none; transition: transform 0.25s ease, opacity 0.25s ease; }'
    + '.nc-panel.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }'

    // Header
    + '.nc-header { background: ' + config.color + '; color: white; padding: 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }'
    + '.nc-header-title { font-size: 16px; font-weight: 600; }'
    + '.nc-close { background: none; border: none; color: white; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 4px; }'
    + '.nc-close:hover { background: rgba(255,255,255,0.2); }'
    + '.nc-close svg { width: 20px; height: 20px; fill: white; }'

    // Messages
    + '.nc-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }'
    + '.nc-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; word-wrap: break-word; white-space: pre-wrap; font-size: 14px; line-height: 1.5; }'
    + '.nc-msg-bot { align-self: flex-start; background: #f3f4f6; color: #1f2937; border-bottom-left-radius: 4px; }'
    + '.nc-msg-user { align-self: flex-end; background: ' + config.color + '; color: white; border-bottom-right-radius: 4px; }'
    + '.nc-msg a { color: inherit; text-decoration: underline; }'

    // Typing indicator
    + '.nc-typing { align-self: flex-start; background: #f3f4f6; padding: 10px 14px; border-radius: 12px; border-bottom-left-radius: 4px; display: none; }'
    + '.nc-typing.show { display: flex; gap: 4px; align-items: center; }'
    + '.nc-dot { width: 6px; height: 6px; background: #9ca3af; border-radius: 50%; animation: nc-bounce 1.4s ease-in-out infinite; }'
    + '.nc-dot:nth-child(2) { animation-delay: 0.2s; }'
    + '.nc-dot:nth-child(3) { animation-delay: 0.4s; }'
    + '@keyframes nc-bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }'

    // Input
    + '.nc-input-area { padding: 12px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; flex-shrink: 0; }'
    + '.nc-input { flex: 1; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 12px; font-size: 14px; font-family: inherit; outline: none; resize: none; }'
    + '.nc-input:focus { border-color: ' + config.color + '; box-shadow: 0 0 0 2px ' + config.color + '33; }'
    + '.nc-send { background: ' + config.color + '; color: white; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: opacity 0.15s; }'
    + '.nc-send:hover { opacity: 0.9; }'
    + '.nc-send:disabled { opacity: 0.5; cursor: not-allowed; }'
    + '.nc-send svg { width: 18px; height: 18px; fill: white; }'

    // Mobile
    + '@media (max-width: 500px) {'
    +   '.nc-panel { width: 100%; height: 100%; bottom: 0; right: 0; border-radius: 0; }'
    +   '.nc-bubble { bottom: 16px; right: 16px; }'
    + '}'
  ;

  // Chat icon SVG
  var chatIconSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
  var closeIconSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  var sendIconSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  var html = ''
    + '<button class="nc-bubble" aria-label="Open chat">'
    +   chatIconSvg
    +   '<span class="nc-unread"></span>'
    + '</button>'
    + '<div class="nc-panel">'
    +   '<div class="nc-header">'
    +     '<span class="nc-header-title">' + escapeHtml(config.name) + '</span>'
    +     '<button class="nc-close" aria-label="Close chat">' + closeIconSvg + '</button>'
    +   '</div>'
    +   '<div class="nc-messages"></div>'
    +   '<div class="nc-input-area">'
    +     '<input class="nc-input" type="text" placeholder="Skriv en melding..." aria-label="Chat message" />'
    +     '<button class="nc-send" aria-label="Send message">' + sendIconSvg + '</button>'
    +   '</div>'
    + '</div>'
  ;

  var wrapper = document.createElement('div');
  shadow.appendChild(style);
  wrapper.innerHTML = html;
  // Move children from wrapper into shadow root
  while (wrapper.firstChild) {
    shadow.appendChild(wrapper.firstChild);
  }

  document.body.appendChild(container);

  // --- Element refs -----------------------------------------------------------

  var bubble = shadow.querySelector('.nc-bubble');
  var unreadDot = shadow.querySelector('.nc-unread');
  var panel = shadow.querySelector('.nc-panel');
  var closeBtn = shadow.querySelector('.nc-close');
  var messagesEl = shadow.querySelector('.nc-messages');
  var input = shadow.querySelector('.nc-input');
  var sendBtn = shadow.querySelector('.nc-send');

  // --- Typing indicator -------------------------------------------------------

  var typingEl = document.createElement('div');
  typingEl.className = 'nc-typing';
  typingEl.innerHTML = '<div class="nc-dot"></div><div class="nc-dot"></div><div class="nc-dot"></div>';
  messagesEl.appendChild(typingEl);

  // --- Helpers ----------------------------------------------------------------

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatReply(text) {
    var escaped = escapeHtml(text);
    // Bold: **text** or __text__
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    // Italic: *text* or _text_ (but not inside URLs)
    escaped = escaped.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<em>$1</em>');
    // Links: make URLs clickable
    escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    // Bullet lists: lines starting with - or •
    escaped = escaped.replace(/^[\-•]\s+(.+)$/gm, '<li>$1</li>');
    escaped = escaped.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Numbered lists: lines starting with 1. 2. etc
    escaped = escaped.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    // Line breaks
    escaped = escaped.replace(/\n/g, '<br>');
    // Clean up <br> inside <ul>
    escaped = escaped.replace(/<br><ul>/g, '<ul>');
    escaped = escaped.replace(/<\/ul><br>/g, '</ul>');
    escaped = escaped.replace(/<br><li>/g, '<li>');
    escaped = escaped.replace(/<\/li><br>/g, '</li>');
    return escaped;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(text, sender) {
    var div = document.createElement('div');
    div.className = 'nc-msg ' + (sender === 'bot' ? 'nc-msg-bot' : 'nc-msg-user');
    div.innerHTML = sender === 'bot' ? formatReply(text) : escapeHtml(text);
    messagesEl.insertBefore(div, typingEl);
    messages.push({ text: text, sender: sender });
    scrollToBottom();
  }

  function showTyping(show) {
    isWaiting = show;
    typingEl.classList.toggle('show', show);
    sendBtn.disabled = show;
    scrollToBottom();
  }

  // --- Open / Close -----------------------------------------------------------

  function openChat() {
    isOpen = true;
    panel.classList.add('open');
    hasUnread = false;
    unreadDot.classList.remove('show');
    input.focus();

    if (messages.length === 0) {
      addMessage(config.welcome, 'bot');
    }
  }

  function closeChat() {
    isOpen = false;
    panel.classList.remove('open');
  }

  bubble.addEventListener('click', function () {
    if (isOpen) {
      closeChat();
    } else {
      openChat();
    }
  });

  closeBtn.addEventListener('click', function () {
    closeChat();
  });

  // --- Send -------------------------------------------------------------------

  function sendMessage() {
    var text = input.value.trim();
    if (!text || isWaiting) return;

    addMessage(text, 'user');
    input.value = '';
    showTyping(true);

    var sessionId = getSessionId();

    fetch(apiUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        sessionId: sessionId,
        site: site,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        showTyping(false);
        var reply = data.reply || data.message || 'Beklager, noe gikk galt.';
        addMessage(reply, 'bot');

        if (!isOpen) {
          hasUnread = true;
          unreadDot.classList.add('show');
        }
      })
      .catch(function (err) {
        showTyping(false);
        addMessage('Beklager, kunne ikke koble til. Pr\u00f8v igjen senere.', 'bot');
        console.error('[NanoClaw Chat]', err);
      });
  }

  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // --- Keyboard shortcuts -----------------------------------------------------

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) {
      closeChat();
    }
  });
})();

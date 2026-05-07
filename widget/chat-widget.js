(function () {
  'use strict';

  // --- Configuration ---------------------------------------------------------

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
      navy: '#1E2F4F',
      primary: '#1A56DB',
      dark: '#1E40AF',
      gray: '#F6F8FB',
      title: 'ATS-hjelpen',
      welcomeTitle: 'Velkommen til ATS Norway!',
      welcomeText: 'Hei! Jeg hjelper deg gjerne med kjøp, salg og spørsmål om brukte anleggsmaskiner, lastebiler og kjøretøy. Hva kan jeg hjelpe deg med i dag?',
      quickReplies: ['Se gravemaskiner', 'Selge utstyr', 'Kontakt'],
    },
    lbs: {
      navy: '#1E2F4F',
      primary: '#97C459',
      dark: '#3B6D11',
      gray: '#F6F8FB',
      title: 'Landbrukshjelpen',
      welcomeTitle: 'Velkommen til Landbrukssalg!',
      welcomeText: 'Hei! Jeg hjelper deg gjerne med kjøp, salg og spørsmål om landbruksutstyr. Hva kan jeg hjelpe deg med i dag?',
      quickReplies: ['Se traktorer', 'Selge utstyr', 'Kontakt'],
    },
  };

  var config = SITES[site] || SITES.ats;

  // --- Session ---------------------------------------------------------------

  var SESSION_KEY = 'nanoclaw_chat_session_' + site;

  function getSessionId() {
    var id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  // --- State -----------------------------------------------------------------

  var isOpen = false;
  var hasUnread = false;
  var messages = [];
  var isWaiting = false;
  var quickRepliesShown = false;

  // --- Helpers (defined early — referenced by HTML template) -----------------

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // --- DOM Creation ----------------------------------------------------------

  var container = document.createElement('div');
  container.id = 'nanoclaw-chat-widget';

  var shadow = container.attachShadow({ mode: 'open' });

  var style = document.createElement('style');
  style.textContent = ''
    + '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }'
    + ':host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; font-size: 14px; line-height: 1.5; color: #1f2937; }'

    // Bubble (chat launcher in bottom-right)
    + '.nc-bubble { position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px; border-radius: 50%; background: ' + config.navy + '; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.15); transition: transform 0.2s ease, box-shadow 0.2s ease; z-index: 2147483646; border: none; }'
    + '.nc-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.2); }'
    + '.nc-bubble svg { width: 28px; height: 28px; }'
    + '.nc-unread { position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; background: #ef4444; border-radius: 50%; border: 2px solid white; display: none; }'
    + '.nc-unread.show { display: block; }'

    // Panel
    + '.nc-panel { position: fixed; bottom: 90px; right: 20px; width: 420px; height: 580px; background: white; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; z-index: 2147483647; transform: translateY(20px) scale(0.95); opacity: 0; pointer-events: none; transition: transform 0.25s ease, opacity 0.25s ease; }'
    + '.nc-panel.open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }'

    // Header
    + '.nc-header { background: ' + config.navy + '; color: white; padding: 14px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }'
    + '.nc-header-icon { width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }'
    + '.nc-header-icon svg { width: 32px; height: 32px; }'
    + '.nc-header-text { flex: 1; display: flex; flex-direction: column; line-height: 1.2; }'
    + '.nc-header-title { font-size: 17px; font-weight: 600; }'
    + '.nc-header-status { font-size: 12px; color: ' + config.primary + '; display: flex; align-items: center; gap: 5px; margin-top: 2px; }'
    + '.nc-status-dot { width: 7px; height: 7px; border-radius: 50%; background: ' + config.primary + '; display: inline-block; }'
    + '.nc-close { background: none; border: none; color: white; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 4px; }'
    + '.nc-close:hover { background: rgba(255,255,255,0.15); }'
    + '.nc-close svg { width: 22px; height: 22px; fill: white; }'

    // Welcome card
    + '.nc-welcome { background: ' + config.gray + '; padding: 16px 18px; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; }'
    + '.nc-welcome.hidden { display: none; }'
    + '.nc-welcome-title { font-size: 15px; font-weight: 700; color: ' + config.navy + '; margin-bottom: 4px; }'
    + '.nc-welcome-text { font-size: 13.5px; color: #4b5563; line-height: 1.45; }'

    // Messages area
    + '.nc-messages { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: white; }'

    // Bot/user message rows (with avatar)
    + '.nc-msg-row { display: flex; gap: 8px; align-items: flex-end; max-width: 100%; }'
    + '.nc-msg-row-bot { justify-content: flex-start; }'
    + '.nc-msg-row-user { justify-content: flex-end; }'
    + '.nc-avatar { width: 30px; height: 30px; border-radius: 50%; background: ' + config.navy + '; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }'
    + '.nc-avatar svg { width: 18px; height: 18px; }'

    // Message bubbles
    + '.nc-msg { max-width: 78%; padding: 10px 14px; border-radius: 14px; word-wrap: break-word; font-size: 14px; line-height: 1.5; }'
    + '.nc-msg-bot { background: ' + config.gray + '; color: #1f2937; border-bottom-left-radius: 4px; }'
    + '.nc-msg-user { background: ' + config.primary + '; color: white; border-bottom-right-radius: 4px; }'
    + '.nc-msg a { color: inherit; text-decoration: underline; }'

    // Markdown elements (bot messages — content rendered server-side)
    + '.nc-msg-bot p { margin: 0 0 8px 0; }'
    + '.nc-msg-bot p:last-child { margin-bottom: 0; }'
    + '.nc-msg-bot h2, .nc-msg-bot h3, .nc-msg-bot h4 { margin: 12px 0 4px 0; font-weight: 600; }'
    + '.nc-msg-bot h2 { font-size: 16px; }'
    + '.nc-msg-bot h3 { font-size: 15px; }'
    + '.nc-msg-bot h4 { font-size: 14px; }'
    + '.nc-msg-bot h2:first-child, .nc-msg-bot h3:first-child, .nc-msg-bot h4:first-child { margin-top: 0; }'
    + '.nc-msg-bot ul, .nc-msg-bot ol { margin: 4px 0 8px 18px; padding: 0; }'
    + '.nc-msg-bot li { margin: 2px 0; }'
    + '.nc-msg-bot code { background: #e5e7eb; padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em; }'
    + '.nc-msg-bot pre { background: #1f2937; color: #f3f4f6; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; margin: 8px 0; }'
    + '.nc-msg-bot pre code { background: none; color: inherit; padding: 0; }'
    + '.nc-msg-bot blockquote { border-left: 3px solid #d1d5db; padding: 2px 0 2px 12px; margin: 8px 0; color: #4b5563; }'
    + '.nc-msg-bot hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }'
    + '.nc-msg-bot table { border-collapse: collapse; font-size: 13px; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; white-space: nowrap; }'
    + '.nc-msg-bot th, .nc-msg-bot td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }'
    + '.nc-msg-bot th { background: #e5e7eb; font-weight: 600; }'
    + '.nc-msg-bot tr:nth-child(even) td { background: #fafafa; }'
    + '.nc-msg-bot del { color: #9ca3af; }'

    // Quick reply pills
    + '.nc-quick-replies { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0 0 38px; }'
    + '.nc-quick-replies.hidden { display: none; }'
    + '.nc-quick-reply { background: white; border: 1.5px solid ' + config.dark + '; color: ' + config.dark + '; padding: 7px 14px; border-radius: 999px; cursor: pointer; font-size: 13px; font-weight: 500; font-family: inherit; transition: background 0.15s, color 0.15s; }'
    + '.nc-quick-reply:hover { background: ' + config.dark + '; color: white; }'

    // Typing indicator (with avatar to match bot rows)
    + '.nc-typing-row { display: none; gap: 8px; align-items: flex-end; }'
    + '.nc-typing-row.show { display: flex; }'
    + '.nc-typing { background: ' + config.gray + '; padding: 12px 14px; border-radius: 14px; border-bottom-left-radius: 4px; display: flex; gap: 4px; align-items: center; }'
    + '.nc-dot { width: 6px; height: 6px; background: #9ca3af; border-radius: 50%; animation: nc-bounce 1.4s ease-in-out infinite; }'
    + '.nc-dot:nth-child(2) { animation-delay: 0.2s; }'
    + '.nc-dot:nth-child(3) { animation-delay: 0.4s; }'
    + '@keyframes nc-bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }'

    // Input area
    + '.nc-input-area { padding: 12px 14px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; flex-shrink: 0; background: white; }'
    + '.nc-input { flex: 1; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 14px; font-size: 14px; font-family: inherit; outline: none; resize: none; }'
    + '.nc-input:focus { border-color: ' + config.primary + '; box-shadow: 0 0 0 2px ' + config.primary + '33; }'
    + '.nc-send { background: ' + config.primary + '; color: white; border: none; border-radius: 10px; padding: 8px 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: opacity 0.15s; min-width: 42px; }'
    + '.nc-send:hover { opacity: 0.9; }'
    + '.nc-send:disabled { opacity: 0.5; cursor: not-allowed; }'
    + '.nc-send svg { width: 18px; height: 18px; fill: white; }'

    // Footer
    + '.nc-footer { padding: 8px 14px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #f3f4f6; flex-shrink: 0; background: white; }'
    + '.nc-footer strong { color: ' + config.navy + '; font-weight: 600; }'

    // Resize handle (top-left corner — panel anchored bottom-right)
    + '.nc-resize-handle { position: absolute; top: 0; left: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 1; }'
    + '.nc-resize-handle::before { content: ""; position: absolute; top: 5px; left: 5px; width: 6px; height: 6px; border-top: 2px solid rgba(255,255,255,0.6); border-left: 2px solid rgba(255,255,255,0.6); border-top-left-radius: 2px; }'
    + '.nc-resize-handle:hover::before { border-color: rgba(255,255,255,0.95); }'

    // Mobile
    + '@media (max-width: 500px) {'
    +   '.nc-panel { width: 100% !important; height: 100% !important; bottom: 0; right: 0; border-radius: 0; }'
    +   '.nc-bubble { bottom: 16px; right: 16px; }'
    +   '.nc-resize-handle { display: none; }'
    + '}'
  ;

  // --- SVG icons -------------------------------------------------------------

  // Site-specific brand icon (used in header + bubble + bot avatar)
  // LBS: gear with green leaf accent. ATS: gear with blue wrench accent.
  function brandIconSvg(size, accentColor) {
    var s = size || 24;
    if (site === 'lbs') {
      return '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '">'
        // Gear (white outline)
        + '<path d="M16 2.5l1.6 2.6 2.9-1 .8 3 3.1.4-.4 3.1 2.6 1.6-1.6 2.6 1.6 2.6-2.6 1.6.4 3.1-3.1.4-.8 3-2.9-1L16 26.5l-1.6-2.6-2.9 1-.8-3-3.1-.4.4-3.1L5.4 17l1.6-2.6L5.4 11.8 8 10.2l-.4-3.1 3.1-.4.8-3 2.9 1L16 2.5z" fill="none" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>'
        + '<circle cx="16" cy="14" r="3.2" fill="none" stroke="white" stroke-width="1.6"/>'
        // Green leaf overlay (top-right)
        + '<path d="M21 4 C26 4 28 8 27 12 C23 12 20 9 21 4 Z" fill="' + (accentColor || '#97C459') + '" stroke="' + (accentColor || '#97C459') + '" stroke-width="0.5"/>'
        + '<path d="M22 6 L25 10" stroke="white" stroke-width="0.8" stroke-linecap="round" opacity="0.7"/>'
        + '</svg>';
    }
    // ATS: gear with wrench accent
    return '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '">'
      + '<path d="M16 2.5l1.6 2.6 2.9-1 .8 3 3.1.4-.4 3.1 2.6 1.6-1.6 2.6 1.6 2.6-2.6 1.6.4 3.1-3.1.4-.8 3-2.9-1L16 26.5l-1.6-2.6-2.9 1-.8-3-3.1-.4.4-3.1L5.4 17l1.6-2.6L5.4 11.8 8 10.2l-.4-3.1 3.1-.4.8-3 2.9 1L16 2.5z" fill="none" stroke="white" stroke-width="1.6" stroke-linejoin="round"/>'
      + '<circle cx="16" cy="14" r="3.2" fill="none" stroke="white" stroke-width="1.6"/>'
      // Blue wrench (top-right)
      + '<path d="M22 4 L26 4 L26 8 L24 10 L28 14 L26 16 L22 12 L20 10 L22 8 Z" fill="' + (accentColor || '#1A56DB') + '"/>'
      + '</svg>';
  }

  // Bot avatar (small, just the accent shape on navy circle)
  function avatarIconSvg() {
    var color = config.primary;
    if (site === 'lbs') {
      return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3 C18 3 21 8 19 16 C13 16 9 11 12 3 Z" fill="' + color + '"/><path d="M14 6 L17 13" stroke="white" stroke-width="0.7" stroke-linecap="round" opacity="0.7"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16 3 L21 3 L21 8 L18 11 L21 14 L17 18 L13 14 L11 16 L9 14 L11 12 L8 9 L11 6 L14 9 L16 7 Z" fill="' + color + '"/></svg>';
  }

  var closeIconSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  var sendIconSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  // --- HTML template ---------------------------------------------------------

  var quickReplyButtons = config.quickReplies.map(function (label) {
    return '<button class="nc-quick-reply" data-reply="' + escapeHtml(label) + '">' + escapeHtml(label) + '</button>';
  }).join('');

  var html = ''
    + '<button class="nc-bubble" aria-label="Open chat">'
    +   brandIconSvg(28, config.primary)
    +   '<span class="nc-unread"></span>'
    + '</button>'
    + '<div class="nc-panel">'
    +   '<div class="nc-resize-handle" aria-label="Resize chat" role="separator"></div>'
    +   '<div class="nc-header">'
    +     '<div class="nc-header-icon">' + brandIconSvg(32, config.primary) + '</div>'
    +     '<div class="nc-header-text">'
    +       '<span class="nc-header-title">' + escapeHtml(config.title) + '</span>'
    +       '<span class="nc-header-status"><span class="nc-status-dot"></span>Online nå</span>'
    +     '</div>'
    +     '<button class="nc-close" aria-label="Close chat">' + closeIconSvg + '</button>'
    +   '</div>'
    +   '<div class="nc-welcome">'
    +     '<div class="nc-welcome-title">' + escapeHtml(config.welcomeTitle) + '</div>'
    +     '<div class="nc-welcome-text">' + escapeHtml(config.welcomeText) + '</div>'
    +   '</div>'
    +   '<div class="nc-messages"></div>'
    +   '<div class="nc-input-area">'
    +     '<input class="nc-input" type="text" placeholder="Skriv en melding..." aria-label="Chat message" />'
    +     '<button class="nc-send" aria-label="Send message">' + sendIconSvg + '</button>'
    +   '</div>'
    +   '<div class="nc-footer">Drevet av <strong>KlarTek</strong></div>'
    + '</div>'
  ;

  var wrapper = document.createElement('div');
  shadow.appendChild(style);
  wrapper.innerHTML = html;
  while (wrapper.firstChild) {
    shadow.appendChild(wrapper.firstChild);
  }

  document.body.appendChild(container);

  // --- Element refs ----------------------------------------------------------

  var bubble = shadow.querySelector('.nc-bubble');
  var unreadDot = shadow.querySelector('.nc-unread');
  var panel = shadow.querySelector('.nc-panel');
  var closeBtn = shadow.querySelector('.nc-close');
  var welcomeEl = shadow.querySelector('.nc-welcome');
  var messagesEl = shadow.querySelector('.nc-messages');
  var input = shadow.querySelector('.nc-input');
  var sendBtn = shadow.querySelector('.nc-send');
  var resizeHandle = shadow.querySelector('.nc-resize-handle');

  // --- Resizable panel -------------------------------------------------------

  var SIZE_KEY = 'nanoclaw_chat_size_' + site;
  var MIN_W = 360, MIN_H = 480;

  function maxSize() {
    return {
      w: Math.floor(window.innerWidth * 0.9),
      h: Math.floor(window.innerHeight * 0.8),
    };
  }

  function applySize(w, h) {
    var max = maxSize();
    w = Math.max(MIN_W, Math.min(max.w, w));
    h = Math.max(MIN_H, Math.min(max.h, h));
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    return { w: w, h: h };
  }

  try {
    var saved = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    if (saved && saved.w && saved.h) applySize(saved.w, saved.h);
  } catch (e) { /* ignore corrupt storage */ }

  var resizing = false;
  var startX = 0, startY = 0, startW = 0, startH = 0;

  resizeHandle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    var rect = panel.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', function (e) {
    if (!resizing) return;
    var newW = startW + (startX - e.clientX);
    var newH = startH + (startY - e.clientY);
    applySize(newW, newH);
  });

  document.addEventListener('mouseup', function () {
    if (!resizing) return;
    resizing = false;
    document.body.style.userSelect = '';
    var rect = panel.getBoundingClientRect();
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify({
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }));
    } catch (e) { /* ignore quota errors */ }
  });

  // --- Typing indicator ------------------------------------------------------

  var typingRow = document.createElement('div');
  typingRow.className = 'nc-typing-row';
  typingRow.innerHTML = '<div class="nc-avatar">' + avatarIconSvg() + '</div>'
    + '<div class="nc-typing"><div class="nc-dot"></div><div class="nc-dot"></div><div class="nc-dot"></div></div>';
  messagesEl.appendChild(typingRow);

  // --- Helpers ---------------------------------------------------------------

  function formatReply(html) {
    return html;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideWelcome() {
    welcomeEl.classList.add('hidden');
  }

  function hideQuickReplies() {
    var qr = shadow.querySelector('.nc-quick-replies');
    if (qr) qr.remove();
    quickRepliesShown = false;
  }

  function addMessage(text, sender) {
    var row = document.createElement('div');
    row.className = 'nc-msg-row nc-msg-row-' + sender;

    if (sender === 'bot') {
      row.innerHTML = '<div class="nc-avatar">' + avatarIconSvg() + '</div>'
        + '<div class="nc-msg nc-msg-bot">' + formatReply(text) + '</div>';
    } else {
      row.innerHTML = '<div class="nc-msg nc-msg-user">' + escapeHtml(text) + '</div>';
    }

    messagesEl.insertBefore(row, typingRow);
    messages.push({ text: text, sender: sender });
    scrollToBottom();
  }

  function addQuickReplies() {
    if (quickRepliesShown) return;
    var row = document.createElement('div');
    row.className = 'nc-quick-replies';
    row.innerHTML = quickReplyButtons;
    messagesEl.insertBefore(row, typingRow);
    row.querySelectorAll('.nc-quick-reply').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var reply = btn.getAttribute('data-reply');
        hideQuickReplies();
        sendMessage(reply);
      });
    });
    quickRepliesShown = true;
    scrollToBottom();
  }

  function showTyping(show) {
    isWaiting = show;
    typingRow.classList.toggle('show', show);
    sendBtn.disabled = show;
    scrollToBottom();
  }

  // --- Open / Close ----------------------------------------------------------

  function openChat() {
    isOpen = true;
    panel.classList.add('open');
    hasUnread = false;
    unreadDot.classList.remove('show');
    input.focus();

    // First open: show quick reply pills (welcome card stays visible)
    if (messages.length === 0 && !quickRepliesShown) {
      addQuickReplies();
    }
  }

  function closeChat() {
    isOpen = false;
    panel.classList.remove('open');
  }

  bubble.addEventListener('click', function () {
    if (isOpen) closeChat();
    else openChat();
  });

  closeBtn.addEventListener('click', closeChat);

  // --- Send ------------------------------------------------------------------

  function sendMessage(textOverride) {
    var text = (textOverride !== undefined ? textOverride : input.value).trim();
    if (!text || isWaiting) return;

    // First user message: collapse welcome card to give chat more room
    if (messages.length === 0) hideWelcome();
    hideQuickReplies();

    addMessage(text, 'user');
    if (textOverride === undefined) input.value = '';
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
        addMessage('Beklager, kunne ikke koble til. Prøv igjen senere.', 'bot');
        console.error('[NanoClaw Chat]', err);
      });
  }

  sendBtn.addEventListener('click', function () { sendMessage(); });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // --- Keyboard shortcuts ----------------------------------------------------

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) {
      closeChat();
    }
  });
})();

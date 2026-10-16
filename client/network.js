export function initNetwork(handlers) {
  let ws = null;

  function disconnect() {
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch (err) { void err; }
      ws = null;
    }
  }

  function connect(ip, pass, name) {
    disconnect();
    try {
      ws = new WebSocket('ws://' + ip);
    } catch (err) {
      console.error('WS Connect error', err);
      if (handlers.onError) handlers.onError(err);
      if (handlers.onClose) handlers.onClose();
      return;
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', password: pass, name: name }));
    };
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (handlers.onMessage) handlers.onMessage(data);
    };
    ws.onerror = (e) => {
      console.error('WS Error', e);
      if (handlers.onError) handlers.onError(e);
    };
    ws.onclose = () => {
      console.log('WS Closed');
      if (handlers.onClose) handlers.onClose();
    };
  }

  function send(msgObj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msgObj));
    }
  }

  return { connect, send, disconnect };
}

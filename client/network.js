export function initNetwork(handlers) {
  let ws = null;
  
  function connect(ip, pass, name) {
    ws = new WebSocket('ws://' + ip);
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

  return { connect, send };
}

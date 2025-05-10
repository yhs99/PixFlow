// 소켓 연결을 저장할 변수
let socket = null;
let ports = [];

// 연결된 모든 포트에 메시지 브로드캐스트
function broadcast(message) {
  ports.forEach(port => port.postMessage(message));
}

// SharedWorker 연결 처리
self.onconnect = function(e) {
  const port = e.ports[0];
  ports.push(port);

  port.onmessage = function(e) {
    const data = e.data;

    switch (data.type) {
      case 'init':
        // 소켓이 없으면 새로 생성
        if (!socket) {
          // Socket.IO 클라이언트 스크립트 로드
          importScripts('https://cdn.socket.io/4.7.1/socket.io.min.js');
          
          // 소켓 연결 생성
          socket = io();

          // 소켓 이벤트 리스너 설정
          socket.on('connect', () => {
            broadcast({ type: 'socket_event', event: 'connect', data: socket.id });
          });

          socket.on('disconnect', () => {
            broadcast({ type: 'socket_event', event: 'disconnect' });
          });

          // 모든 소켓 이벤트를 중계
          socket.onAny((eventName, ...args) => {
            broadcast({ type: 'socket_event', event: eventName, data: args[0] });
          });
        }

        // 현재 소켓 상태 전송
        if (socket.connected) {
          port.postMessage({ type: 'socket_event', event: 'connect', data: socket.id });
        }
        break;

      case 'emit':
        // 소켓 이벤트 발생
        if (socket) {
          socket.emit(data.event, data.data);
        }
        break;
    }
  };

  // 포트 연결 해제 시 처리
  port.onmessageerror = () => {
    ports = ports.filter(p => p !== port);
  };

  port.start();
}; 
# 다른 기기에서 접속하기 · Jetson 실행 (D-25)

기본은 **이 기기에서만** 받는다 (`127.0.0.1`). Jetson·파이프라인 보드·다른 PC에서 붙으려면 아래 설정을 함께 준다.

## 서버 설정 (`.env`)

```
HARNESS_WS_HOST=0.0.0.0                       # 모든 네트워크 카드에서 받기 (또는 이 기기의 LAN 주소)
HARNESS_WS_ALLOWED_CLIENTS=192.168.0.20       # 접속을 받을 기기 IP, 여러 개는 쉼표. 대역은 192.168.0.0/24
HARNESS_WS_TOKEN=<24자 이상>
HARNESS_WS_VIEWER_TOKEN=<24자 이상, 위와 다른 값>   # 웹 화면을 쓸 때
HARNESS_WS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://<웹을 여는 주소>:5173
```

- 이 기기 자신(loopback)은 항상 허용된다. 목록에 없는 주소는 연결 단계에서 거부된다 (서버 로그 `거부: 허용되지 않은 클라이언트 주소`).
- `HARNESS_WS_HOST`만 열고 `HARNESS_WS_ALLOWED_CLIENTS`가 없으면 서버가 시작하지 않는다. 토큰이 24자 미만이어도 시작하지 않는다.
- 시작 화면에 `다른 기기 접속: 허용 … → 이 기기 주소 ws://192.168.0.x:8787`이 나온다. 다른 기기는 그 주소로 붙는다.
- **TLS 없이 열면 토큰이 암호화 없이 오간다.** 집·연구실처럼 믿을 수 있는 같은 네트워크에서만 쓴다. 필요하면 `HARNESS_WS_TLS_CERT`/`HARNESS_WS_TLS_KEY`(PEM 파일)로 `wss://`를 연다. 자체 서명 인증서면 클라이언트 쪽에서 `NODE_EXTRA_CA_CERTS=<인증서>`로 신뢰시켜야 한다.

## 구성 예

| 구성 | Harness 서버 | 접속하는 쪽 | `HARNESS_WS_ALLOWED_CLIENTS` |
| --- | --- | --- | --- |
| A. 최종 형태 | Jetson | 파이프라인(같은 Jetson, loopback) + 노트북 브라우저(웹 화면) | 노트북 IP |
| B. 개발 중 | 노트북 | Jetson의 파이프라인·데모 | Jetson IP |

- B에서 노트북이 Windows면 **방화벽 인바운드 규칙**으로 TCP 8787을 열어야 한다 (처음 실행 때 뜨는 허용 창에서 "개인 네트워크" 허용).
- 접속하는 쪽 `.env`: `HARNESS_WS_URL=ws://<서버 IP>:8787`, `HARNESS_WS_TOKEN=<서버와 같은 값>`.
- 웹 화면을 다른 기기에서 열려면 웹을 띄우는 기기에서 `pnpm web:dev:lan`(Vite를 0.0.0.0으로) → 브라우저 주소의 Origin(`http://<그 기기 IP>:5173`)을 서버 `HARNESS_WS_ALLOWED_ORIGINS`에 넣고, 그 브라우저 기기 IP를 `HARNESS_WS_ALLOWED_CLIENTS`에 넣는다.

## Jetson 준비

1. Node.js **22.13 이상** (arm64). JetPack(Ubuntu 22.04) 기본 Node는 오래돼서 nvm 등으로 설치한다.
   ```
   node -v      # v22.13 이상
   corepack enable && corepack prepare pnpm@latest --activate
   ```
2. 코드 받기: `git clone <app 저장소>` 후 `cd app && pnpm install`.
3. `.env`는 저장소에 없다. 노트북의 `.env`를 **직접** 옮긴다 (비밀값이 있으니 메신저·공유 폴더에 올리지 않는다). 구성에 맞게 위 설정을 바꾼다.
4. 확인
   ```
   pnpm test                 # 자동 테스트 (네트워크 불필요)
   pnpm smoke                # 실제 GitHub·Eureka 읽기, LLM 짧은 호출
   pnpm harness              # 시작 화면의 '다른 기기 접속' 줄 확인
   ```
5. 기록할 것 (POC): 시작 시간, `pnpm harness` 실행 중 메모리(`free -m`, `top`의 node RES), SQLite 파일 경로·크기, `pnpm smoke llm`의 응답 시간.

## 확인한 것

`tests/e2e/remoteAccess.test.ts` — 허용 목록이 비면 loopback만 받음, 허용 대역이면 LAN 주소 접속 수락, TLS 인증서로 `wss://` 수락(평문 `ws://` 거부), 주소 규칙(IPv4·CIDR·IPv6). 실제 두 기기 사이 접속은 Jetson에서 확인해야 한다.

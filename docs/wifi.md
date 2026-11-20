# Wi-Fi 설정 (D-59)

웹 **설정 → Wi-Fi**에서 젯슨이 연결할 Wi-Fi를 찾고 연결한다. 관리 토큰은 필요 없다 (사용자 결정 2026-11-20).
서버가 젯슨의 NetworkManager(`nmcli`)를 부른다. 리눅스에서만 켜지고, `DESKPET_WIFI=off`로 끈다.

## 할 수 있는 것

- 현재 상태: 장치, 연결 상태, SSID, 신호, 주소 (30초마다 다시 읽어 웹에 알림)
- 주변 Wi-Fi 찾기: 같은 이름은 연결 중이거나 신호가 센 것 하나만, 잠김·개방·계정 표시
- 연결
  - 개인 Wi-Fi(WPA-PSK)·개방: `nmcli device wifi connect <SSID> password <비밀번호> ifname <장치>`
  - 학교·회사 계정 Wi-Fi(WPA2-Enterprise): PEAP + MSCHAPv2 프로필을 만들어 올림 (`802-1x.identity`, `802-1x.password`). 같은 이름의 예전 프로필은 지우고 새로 만든다

## 비밀번호

- NetworkManager에만 저장된다. Harness 파일·세션 기록·서버 로그에는 남기지 않고, nmcli 오류 출력에 섞이면 `***`로 가린다
- 웹 화면은 비밀번호를 보내기만 하고 저장하지 않는다
- 인자는 셸을 거치지 않고 배열로 넘긴다. 다만 연결하는 몇 초 동안 같은 기기 사용자에게 `ps`로 nmcli 인자가 보일 수 있다

## 젯슨 준비: polkit 규칙 (서비스로 돌릴 때 필요)

데스크톱에 로그인한 상태가 아니면(systemd 서비스, SSH) NetworkManager가 일반 사용자의 Wi-Fi 변경을 막는다.
웹에 "Wi-Fi를 바꿀 권한이 없어요"가 나오면 아래 규칙을 한 번 넣는다 (Ubuntu 22.04, polkit 0.105).

```bash
sudo tee /etc/polkit-1/localauthority/50-local.d/50-deskpet-network.pkla >/dev/null <<'RULE'
[DeskPet: Wi-Fi 설정 허용]
Identity=unix-user:hansungai
Action=org.freedesktop.NetworkManager.*
ResultAny=yes
ResultInactive=yes
ResultActive=yes
RULE
sudo systemctl restart polkit
```

## Wi-Fi 없이 웹에 들어가는 법

Wi-Fi가 끊겨 있으면 웹에 들어올 길이 먼저 필요하다.

- 젯슨에 모니터를 연결해 젯슨에서 `http://127.0.0.1:8787`
- USB-C로 PC와 연결: 젯슨은 항상 `192.168.55.1`. 서버를 다른 기기 접속으로 연다 (`docs/remote-access.md`)
  ```
  HARNESS_WS_HOST=0.0.0.0
  HARNESS_WS_ALLOWED_CLIENTS=192.168.55.0/24
  ```
  PC 브라우저에서 `http://192.168.55.1:8787` → 설정 → Wi-Fi
- 다른 기기 접속을 열면 `HARNESS_WS_ALLOWED_CLIENTS` 안의 누구나 Wi-Fi를 바꿀 수 있다 (관리 토큰 없음). 허용 대역을 좁게 둔다

연결 중인 Wi-Fi로 웹을 보고 있다가 다른 Wi-Fi로 바꾸면 그 화면은 끊긴다. 새 주소는 연결 결과에 나온다.

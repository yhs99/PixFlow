# ChatGPT API 연동 가이드 - 수비학 운세

## 1. 필요한 패키지 설치

```bash
npm install axios
```

## 2. 환경 변수 설정

`.env` 파일에 OpenAI API 키를 추가하세요:

```
# .env 또는 .env.production 파일
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
OPENAI_API_KEY=your_openai_api_key_here
API_ENDPOINT=your_api_endpoint
```

## 3. OpenAI API 키 얻기

1. [OpenAI 플랫폼](https://platform.openai.com/account/api-keys)에 접속합니다.
2. 계정을 만들거나 로그인합니다.
3. "API Keys" 섹션으로 이동합니다.
4. "Create new secret key" 버튼을 클릭합니다.
5. 생성된 API 키를 복사하여 `.env` 파일에 붙여넣습니다.

## 4. 수비학 운세 기능 설명

이 기능은 사용자의 생년월일로부터 운명수(Destiny Number)를 계산하고, ChatGPT API를 활용하여 그에 맞는 운세를 제공합니다.

### 운명수 계산 방법
1. 생년월일의 모든 숫자를 더합니다. (예: 19901210 -> 1+9+9+0+1+2+1+0 = 23)
2. 합계가 한 자리가 될 때까지 각 자릿수를 더합니다. (예: 23 -> 2+3 = 5)
3. 최종 숫자(1~9)가 운명수입니다.

### 각 운명수의 일반적 의미
- **1번**: 리더십, 독립성, 창의성
- **2번**: 협력, 균형, 조화
- **3번**: 표현력, 낙관주의, 창의성
- **4번**: 안정성, 성실함, 현실주의
- **5번**: 자유, 변화, 모험
- **6번**: 책임감, 사랑, 조화
- **7번**: 분석력, 지혜, 내면의 성찰
- **8번**: 성취, 물질적 풍요, 권위
- **9번**: 완성, 관용, 봉사

## 5. 봇 재시작

환경 변수를 설정한 후 봇을 재시작하세요:

```bash
node bot/index.js
```

## 6. 추가 커스터마이징

`운세.js` 파일의 `getFortuneFromChatGPT` 함수를 수정하여 다음을 변경할 수 있습니다:

- 다른 모델 사용 (GPT-4 등)
- 시스템 프롬프트 변경
- 운명수 계산 방식 변경 (다른 수비학 시스템 적용)
- 온도(temperature) 값 조정
- 토큰 수 제한 조정

## 7. 요금 관리

OpenAI API는 사용량에 따라 요금이 부과됩니다. 비용 관리를 위해 다음을 고려하세요:

- 적절한 토큰 제한 설정 (max_tokens)
- API 호출 빈도 제한
- [OpenAI 대시보드](https://platform.openai.com/account/usage)에서 사용량 모니터링 
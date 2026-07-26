# majsoul-monthTicket-auto

> 경고: 이 프로젝트 사용으로 인해 발생하는 불이익, 계정 제재 등 모든 결과에 대한 책임은 이용자 본인에게 있습니다.

![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/89844790-9a47-40b7-8e65-ed07430f3917)
![image](https://github.com/4n3u/majsoul-monthTicket-auto/assets/167657823/720689fa-7237-4d85-8979-c3e768c7f1d9)

이 프로젝트는 GitHub Actions를 이용해 작혼에 자동으로 접속하여 출석 업적(8bit 리치 BGM)을 채우고 매일 운수 부적을 수령합니다.  

## 사전 준비
1. 웹 브라우저로 작혼에 접속합니다.
2. `F12`를 눌러 개발자 도구를 연 뒤 `Console` 탭으로 이동합니다.
3. 아래 코드를 실행합니다.
   ```js
   {
     const r = await test_sdk.Login({ openQuickLogin: true });
     if (r.code !== 0) throw new Error(`${r.code}: ${r.msg}`);
     console.log(`UID: ${r.data.LOGIN_UID}\nTOKEN: ${r.data.LOGIN_TOKEN}`);
   }
   ```
4. 출력된 `UID`와 `TOKEN` 값을 기록한 뒤 JP/EN/KR 서버 설정에 사용합니다. `test_sdk`가 없다고 나오면 게임 로딩이 끝난 뒤 다시 실행합니다.
5. CN 서버는 계정의 이메일과 비밀번호를 기억하시면 됩니다.

## 설정 방법
1. 이 프로젝트를 GitHub에서 포크합니다.
2. 포크한 저장소에서 `Settings > Secrets and variables > Actions`로 이동합니다.
3. `New repository secret` 버튼을 눌러 `MS_SERVER` 시크릿을 추가합니다.
4. `MS_SERVER` 값은 사용할 서버에 따라 `jp`, `en`, `kr`, `cn` 중 하나를 입력합니다. 입력하지 않으면 기본값은 `jp`입니다.
5. `jp`, `en`, `kr` 서버를 사용할 경우 `New repository secret` 버튼을 다시 눌러 `UID`와 `TOKEN` 시크릿을 추가합니다. JP 서버는 같은 브라우저에서 아래 방법으로 확인한 `YOSTAR_DEVICE_ID`도 추가합니다. 기존 `ACCESS_TOKEN` 시크릿이 있으면 먼저 재사용하고, 거부될 때 `UID`와 `TOKEN`으로 자동 재인증합니다.
6. `cn` 서버를 사용할 경우 `New repository secret` 버튼을 다시 눌러 `EMAIL`과 `PASSWORD` 시크릿을 추가합니다. 값에는 계정 이메일과 비밀번호 원문을 입력합니다.
7. `Settings > Actions > General`로 이동해 `Workflow permissions`를 `Read and write permissions`로 변경합니다.
8. 예약 출석은 `Asia/Seoul` 기준 오전 **6시 7분과 6시 17분**에만 시도합니다. GitHub Actions가 지연되어 실제 시작 시각이 **6시 25분 이상이면 로그인하지 않고 종료**합니다.
9. 별도 `Attendance Safety Check`은 오전 **6시 50분**에 성공 기록만 확인합니다. 미완료여도 게임 세션 보호를 위해 출석 워크플로를 다시 호출하지 않으며, 빨간 Actions 실행과 요약으로 수동 확인을 요청합니다.
10. 저장소 상단 `Actions` 탭에서 `Login to Majsoul`과 `Attendance Safety Check`을 각각 활성화합니다.

## 접속 중인 게임 세션 보호
- 작혼 서버의 현재 플레이 여부를 로그인 전에 안전하게 확인할 수 있는 신뢰 가능한 API가 없습니다.
- 자동화가 `oauth2Login`까지 진행하면 기존 브라우저나 앱 세션이 중복 접속으로 종료될 수 있습니다.
- 이를 피하기 위해 자동 로그인은 06:00~06:25 KST의 짧은 보호 시간대에만 허용합니다.
- 오전 6시 25분 이후에는 성공 기록이 없어도 자동 재로그인하지 않습니다.
- 늦은 시간의 미완료 상태는 `Attendance Safety Check`이 알림만 남기며, 실제 로그인은 사용자가 게임에서 로그아웃한 뒤 수동으로 실행해야 합니다.

## 수동 실행 방법
1. 먼저 브라우저와 모바일 앱을 포함해 작혼에서 로그아웃했는지 확인합니다.
2. `Actions > Login to Majsoul`을 엽니다.
3. `Run workflow`를 누릅니다.
4. **`Use workflow from`은 반드시 `main`을 선택합니다.** 다른 브랜치를 선택하면 계정 Secret 보호를 위해 출석은 실행되지 않으며, 실행 화면에 원인이 표시됩니다.
5. **`현재 게임에 접속 중이 아니며 중복 로그인으로 기존 세션이 종료될 수 있음을 확인`을 반드시 켭니다.** 끄면 수동 로그인이 차단됩니다.
6. 오늘 이미 성공했어도 다시 실행해야 할 때만 `오늘 이미 성공했어도 다시 실행`을 켭니다. 기본값은 꺼짐입니다.
7. 정상 실행 시 `attendance-run-report.json` 진단 파일과 단계별 실행 요약을 확인할 수 있습니다.

## 클라이언트 업데이트 처리
- 매 실행 시 용량이 작은 공식 `version.json`과 Unity `productVersion`만 먼저 확인합니다.
- 변경이 없으면 직전에 성공한 클라이언트 설정을 즉시 재사용합니다.
- Unity `productVersion`은 패키지/라우팅 버전으로 사용합니다. 게임 인증용 리소스 버전은 마지막 성공값을 먼저 사용하고, 공식 구버전 오류 150이 발생한 경우에만 제한된 범위를 순차 탐색한 뒤 성공값을 캐시에 저장합니다.
- 라우트 연결은 최신 Unity 클라이언트와 동일하게 Web 플랫폼 필드와 초 단위 시각을 전송합니다. 로그인 큐 오류 151은 버전 탐색으로 오인하지 않고 라우트와 세션을 새로 받아 재시도합니다.
- Unity 클라이언트가 실제로 사용하는 값은 `docs_version/version.json`의 `version`이며, 업데이트 복구 시 마지막 성공값의 앞·뒤 후보를 교차 확인합니다.
- 매 실행 시 게임 인증 전에 공식 YoStar WebSDK의 `quick-login`으로 로그인 토큰의 유효기간을 연장합니다.
- SDK 버전, API 주소, 서명 정보는 암호화 캐시에서 즉시 재사용하고, 캐시가 거부될 때만 공식 클라이언트에서 최신값을 다시 수집합니다.
- 공식 WebSDK가 게임에 넘기는 기존 `UID`/`TOKEN`을 우선 사용하고, quick-login 응답의 캐시용 토큰은 인증 실패 때만 제한적으로 재시도합니다. 성공한 로그인 상태는 기존 `UID`/`TOKEN` 시크릿으로 암호화해 `auth-cache.json`에 저장하므로 다음 실행부터 바로 재사용하며, 평문 토큰은 저장소에 기록하지 않습니다.
- 현재 Unity 클라이언트에는 예전 `game`/`Laya` 전역 객체가 없으므로 위의 `test_sdk.Login` 방법을 사용해야 합니다.

### JP YoStar DeviceID 확인

JP 로그인 토큰은 발급한 브라우저의 YoStar DeviceID와 함께 검증됩니다. 게임을 로그인한 브라우저의 개발자 도구 콘솔에서 아래 코드를 실행하고, 출력된 값만 `YOSTAR_DEVICE_ID` Secret에 저장합니다.

```js
{
  const request = indexedDB.open('websdk');
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const get = db.transaction('cache', 'readonly')
    .objectStore('cache')
    .get('cache');
  const cache = await new Promise((resolve, reject) => {
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => reject(get.error);
  });
  console.log(`YOSTAR_DEVICE_ID: ${cache.deviceId}`);
}
```

## 주의
- GitHub Actions 예약 실행은 서버 부하에 따라 지연되거나 누락될 수 있습니다. 지연 실행이 6시 25분을 넘으면 접속 충돌 방지를 우선해 자동 출석을 포기합니다.
- 자동 출석 성공률보다 현재 플레이 세션 보호를 우선하는 정책입니다. 미완료 알림이 나오면 게임에서 로그아웃한 뒤 수동 실행하세요.
- 액세스 토큰과 계정 정보는 외부에 노출되지 않도록 주의하세요.

## 문의
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)

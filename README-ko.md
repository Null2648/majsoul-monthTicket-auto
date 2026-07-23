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
8. 기본 실행 시각은 매일 JST 기준 오전 6시 05분입니다. 변경하려면 `.github/workflows/main.yml`의 `cron` 값을 수정합니다.
9. 저장소 상단 `Actions` 탭으로 이동해 `I understand my workflows, go ahead and enable them` 버튼을 눌러 워크플로를 활성화합니다.
10. 왼쪽 `Workflows` 목록에서 `Login to Majsoul`을 선택하고 `Enable workflow`를 눌러 워크플로를 켭니다.

## 테스트 방법
1. 브라우저에서 작혼 계정을 로그인 상태로 둡니다.
2. GitHub의 `Actions > Workflows`에서 `Run workflow`를 클릭해 수동 실행합니다.
3. 올바르게 동작하면 브라우저 세션이 서버에 의해 종료됩니다.

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
- GitHub Actions는 서버 상황에 따라 최대 30분까지 지연될 수 있습니다.
- 액세스 토큰과 계정 정보는 외부에 노출되지 않도록 주의하세요.

## 문의
- [Discord](https://discord.com/users/245702966085025802)
- [X](https://x.com/xflVsSnvB6cx8ZM)

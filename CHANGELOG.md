# 변경 이력

앱(git403)의 버전별 변경 내역. 배포 스크립트가 해당 버전 절을 GitHub 릴리스 노트로 쓴다. VS Code 확장은 `vscode/CHANGELOG.md`.

## 1.0.2

- macOS 메뉴 막대의 "저장소 열기"가 폴더 선택 없이 "git 실행 실패"를 내던 문제 수정
- Finder·Dock으로 실행했을 때 상태바의 GitHub 계정과 AI(Claude 등 CLI)가 꺼진 것으로 보이던 문제 수정
- Finder·Dock으로 실행한 직후 Git LFS 저장소를 열거나 전환하면 git-lfs를 못 찾아 실패하던 문제 수정
- 작성자 프로필 사진을 일시적으로 못 가져오면(GitHub 요청 한도·네트워크) 계속 이니셜로 남던 문제 수정: 잠시 뒤 다시 가져온다
- 저장소에 연결한 GitHub 계정을 확인하지 못하면 다른 계정으로 push·PR을 진행하던 문제 수정: 이제 원인을 알리고 멈춘다
- 실패를 "없음"으로 잘못 보여 주던 곳 정리: 설정(빈칸), PR 목록(0개), 원격(없음), 커밋 변경 파일·diff(빈 화면), Git LFS(미설치), git(미설치) 대신 실제 원인을 보여 준다
- push가 거부되면 오류에 `hint:` 줄 대신 `! [rejected]`·`error:` 같은 실제 원인을 보여 준다
- 셸 설정이 무거워도(nvm·conda 등) 로그인 셸 PATH를 기다리고, 끝내 못 읽으면 Homebrew 등 흔한 설치 위치를 쓴다

## 1.0.0

- 첫 공개 버전: 커밋 그래프, 파일·hunk·줄 단위 스테이지, merge·rebase·cherry-pick·충돌 해결, 스태시, 서브모듈·worktree·LFS·git-flow, 호스팅 연동(GitHub·GitLab·Bitbucket·Gitea), AI 도우미(선택)
- macOS(Apple Silicon·Intel 각각)·Windows x64 설치 파일, 앱 안 자동 업데이트
- 상태바의 버전을 누르면 이 릴리스 노트가 열립니다
- VS Code 확장: 같은 커밋 그래프를 VS Code 안에서 (마켓플레이스 `goldtagworks.git403-vscode`)
- macOS는 Homebrew로 설치: `brew tap goldtagworks/git403 https://github.com/goldtagworks/git403 && brew install --cask git403`

코드 서명 없는 개인용 빌드입니다. 설치·업데이트: README 참고

# Organization review wiki

이 디렉터리는 PR 리뷰 봇이 **GitHub organization 단위**로 읽는 사람이 관리하는 공용 기준입니다.

## 페이지 생성

`<organization>.md` 파일을 만들고, PR의 GitHub organization과 같은 `owner` frontmatter를 선언합니다.

```md
---
owner: kungbi-spiders
---

# Shared review conventions

## API contract changes

- 공유 request/response 계약을 바꾸면 직접 consumer와 버전 호환성을 확인한다.
- 내부 구현 전용 변경에는 적용하지 않는다.

## Deployment exceptions

- 환경별 예외는 적용 환경과 종료 조건을 함께 기록한다.
```

## 로드·신뢰 경계

- 봇은 현재 PR의 GitHub organization과 **파일명 및 `owner` 값이 일치하는 페이지 하나만** 읽습니다.
- frontmatter 누락, owner 불일치, 빈 본문, 파일 읽기 오류는 해당 wiki만 무시하며 리뷰는 계속합니다.
- 레포별 runtime lesson(`state/review-memory.json`)은 자동으로 이 wiki에 승격되지 않습니다.
- 이 Markdown은 1차 draft 모델에만 **비신뢰 참고 데이터**로 주입됩니다. 현재 PR의 코드·diff와 레포별 명시 합의가 항상 우선합니다.
- 공용 규칙 추가·수정·삭제는 이 파일을 포함한 PR로 검토합니다.

문서가 커지면 의도적으로 섹션/페이지를 나눠 관리합니다. 봇은 공용 기준을 top-N 항목으로 조용히 생략하지 않습니다.

export const BOT_AUTHOR_DISCLOSURE = '---\n_🤖 이 댓글은 PR Reviewer Bot(AI)이 자동 작성했습니다._';

const BOT_AUTHOR_DISCLOSURE_MARKER = 'PR Reviewer Bot(AI)이 자동 작성했습니다';

export function appendBotAuthorDisclosure(body: string): string {
  const trimmed = body.trim();
  if (trimmed.includes(BOT_AUTHOR_DISCLOSURE_MARKER)) {
    return trimmed;
  }
  if (!trimmed) {
    return BOT_AUTHOR_DISCLOSURE;
  }
  return `${trimmed}\n\n${BOT_AUTHOR_DISCLOSURE}`;
}

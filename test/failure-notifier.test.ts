import { sendReviewFailedNotification, sendReviewStartedNotification } from '../src/discord-notifier';

afterEach(() => { jest.restoreAllMocks(); });

test('durably reserved terminal operator notification never retries an ambiguous POST', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('response lost'));
  const result = await sendReviewFailedNotification({ owner: 'org', repo: 'repo', prNumber: 1,
    prTitle: 'fixture', errorMessage: 'analysis failed', permanentlySkipped: true });
  expect(result).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
}, 10_000);

test('ordinary start notification retains its existing retry behavior', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue({ ok: true } as Response);
  expect(await sendReviewStartedNotification({ owner: 'org', repo: 'repo', prNumber: 1, prTitle: 'fixture' })).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

jest.mock('axios');
import axios from 'axios';
import { postComment } from '../src/github';

test('failure comment POST is a single transport attempt even when response is lost', async () => {
  const post = axios.post as jest.Mock;
  post.mockRejectedValue(Object.assign(new Error('connection reset after commit'), { code: 'ECONNRESET' }));
  await expect(postComment('org', 'repo', 1, 'failure')).rejects.toThrow('connection reset');
  expect(post).toHaveBeenCalledTimes(1);
}, 20_000);

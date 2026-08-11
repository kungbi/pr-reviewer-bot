const stopCron = jest.fn();
const schedule = jest.fn(() => ({ stop: stopCron }));

jest.mock('node-cron', () => ({
  __esModule: true,
  default: { schedule },
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn().mockResolvedValue({ data: { items: [] } }) },
}));

import { startPolling } from '../src/poller';

describe('poller shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stops the cron schedule and drains the current polling tick', async () => {
    const controller = startPolling(1);

    const result = await controller.stop(1_000);

    expect(schedule).toHaveBeenCalledWith('*/1 * * * *', expect.any(Function));
    expect(stopCron).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ drained: true, activeCount: 0 });
  });
});

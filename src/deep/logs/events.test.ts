import { describe, expect, it } from 'vitest';
import {
  emptyTail,
  eventKey,
  MAX_TAIL_EVENTS,
  mergeTail,
  readEvents,
  readLogGroups,
  readLogStreams,
  TAIL_LOOKBACK_MS,
  tailStartTime,
  type LogEvent,
} from './events';

/**
 * Fixtures are the shapes the CloudWatch Logs model declares for
 * `DescribeLogGroups`, `DescribeLogStreams` and `FilterLogEvents` — timestamps
 * in epoch milliseconds, as that model says.
 */

describe('readLogGroups', () => {
  it('reads a group and its retention', () => {
    const groups = readLogGroups({
      logGroups: [
        {
          logGroupName: '/glaux/firehose/orders',
          arn: 'arn:aws:logs:us-east-1:000000000000:log-group:/glaux/firehose/orders:*',
          creationTime: 1_756_000_000_000,
          retentionInDays: 7,
          storedBytes: 4096,
          logGroupClass: 'STANDARD',
          metricFilterCount: 0,
        },
      ],
    });
    expect(groups).toEqual([
      {
        name: '/glaux/firehose/orders',
        arn: 'arn:aws:logs:us-east-1:000000000000:log-group:/glaux/firehose/orders:*',
        creationTime: 1_756_000_000_000,
        retentionInDays: 7,
        storedBytes: 4096,
        logGroupClass: 'STANDARD',
        metricFilterCount: 0,
      },
    ]);
  });

  it('falls back to logGroupArn, which newer models return instead of arn', () => {
    const [group] = readLogGroups({
      logGroups: [{ logGroupName: 'a', logGroupArn: 'arn:aws:logs:::log-group:a' }],
    });
    expect(group.arn).toBe('arn:aws:logs:::log-group:a');
  });

  it('skips an entry with no name rather than showing a nameless row', () => {
    expect(readLogGroups({ logGroups: [{ retentionInDays: 1 }, 'nonsense'] })).toEqual([]);
    expect(readLogGroups({})).toEqual([]);
    expect(readLogGroups(undefined)).toEqual([]);
  });
});

describe('readLogStreams', () => {
  it('reads a stream’s activity timestamps', () => {
    expect(
      readLogStreams({
        logStreams: [
          {
            logStreamName: '2026/08/27/[$LATEST]abc',
            creationTime: 1_756_000_000_000,
            firstEventTimestamp: 1_756_000_001_000,
            lastEventTimestamp: 1_756_000_009_000,
            lastIngestionTime: 1_756_000_010_000,
          },
        ],
      }),
    ).toEqual([
      {
        name: '2026/08/27/[$LATEST]abc',
        creationTime: 1_756_000_000_000,
        firstEventTimestamp: 1_756_000_001_000,
        lastEventTimestamp: 1_756_000_009_000,
        lastIngestionTime: 1_756_000_010_000,
      },
    ]);
  });

  it('reads a stream that has never been written to', () => {
    const [stream] = readLogStreams({ logStreams: [{ logStreamName: 'empty' }] });
    expect(stream.name).toBe('empty');
    expect(stream.lastEventTimestamp).toBeUndefined();
  });
});

describe('readEvents', () => {
  it('reads the members FilterLogEvents returns', () => {
    expect(
      readEvents({
        events: [
          {
            eventId: '38123',
            logStreamName: 'stream-a',
            timestamp: 1_756_000_000_000,
            ingestionTime: 1_756_000_000_500,
            message: 'started',
          },
        ],
      }),
    ).toEqual([
      {
        eventId: '38123',
        logStreamName: 'stream-a',
        timestamp: 1_756_000_000_000,
        ingestionTime: 1_756_000_000_500,
        message: 'started',
      },
    ]);
  });

  it('keeps an event whose message is empty, which is a real log line', () => {
    expect(readEvents({ events: [{ eventId: '1', timestamp: 1, message: '' }] })).toHaveLength(1);
  });
});

describe('eventKey', () => {
  it('is the service’s own event id when there is one', () => {
    expect(eventKey({ eventId: '38123', message: 'x' })).toBe('38123');
  });

  it('falls back to stream, timestamp and message for a target that omits it', () => {
    expect(eventKey({ logStreamName: 's', timestamp: 12, message: 'x' })).toBe('s|12|x');
    // Two different lines at the same instant are still two keys.
    expect(eventKey({ logStreamName: 's', timestamp: 12, message: 'y' })).not.toBe('s|12|x');
  });
});

function event(id: string, timestamp: number, message = id): LogEvent {
  return { eventId: id, logStreamName: 'stream-a', timestamp, message };
}

describe('mergeTail', () => {
  it('advances the window to the newest event it has seen', () => {
    const start = 1_756_000_000_000;
    const merged = mergeTail(emptyTail(), [event('1', start + 10), event('2', start + 20)]);
    expect(merged.events.map(e => e.eventId)).toEqual(['1', '2']);
    // Inclusive, so the next poll re-reads the newest event rather than risking
    // a sibling written in the same millisecond.
    expect(merged.nextStartTime).toBe(start + 20);
  });

  it('drops the overlap the inclusive window re-delivers', () => {
    const start = 1_756_000_000_000;
    const first = mergeTail(emptyTail(), [event('1', start + 10), event('2', start + 20)]);
    const second = mergeTail(first, [event('2', start + 20), event('3', start + 30)]);
    expect(second.events.map(e => e.eventId)).toEqual(['1', '2', '3']);
    expect(second.nextStartTime).toBe(start + 30);
  });

  it('deduplicates a target that returns no event id', () => {
    const line = { logStreamName: 'stream-a', timestamp: 5, message: 'once' };
    const first = mergeTail(emptyTail(), [line]);
    const second = mergeTail(first, [line]);
    expect(second.events).toHaveLength(1);
  });

  it('is the same state object when a poll brings nothing new', () => {
    const first = mergeTail(emptyTail(), [event('1', 10)]);
    // Identity matters: an unchanged tail must not re-render the panel every
    // two seconds while nothing is being written.
    expect(mergeTail(first, [event('1', 10)])).toBe(first);
    expect(mergeTail(first, [])).toBe(first);
  });

  it('orders a poll that interleaves streams by timestamp', () => {
    const merged = mergeTail(emptyTail(), [
      { eventId: 'b', logStreamName: 'two', timestamp: 30, message: 'b' },
      { eventId: 'a', logStreamName: 'one', timestamp: 10, message: 'a' },
      { eventId: 'c', logStreamName: 'one', timestamp: 20, message: 'c' },
    ]);
    expect(merged.events.map(e => e.eventId)).toEqual(['a', 'c', 'b']);
  });

  it('keeps the newest events once the panel is full, and counts what it dropped', () => {
    const many = Array.from({ length: MAX_TAIL_EVENTS + 5 }, (_, index) =>
      event(String(index), index),
    );
    const merged = mergeTail(emptyTail(), many);
    expect(merged.events).toHaveLength(MAX_TAIL_EVENTS);
    expect(merged.dropped).toBe(5);
    expect(merged.events[0].eventId).toBe('5');
    // A trimmed event is forgotten, which is safe: the window has moved past it.
    expect(merged.seen).not.toContain('0');
    expect(merged.seen).toContain(String(MAX_TAIL_EVENTS + 4));
  });

  it('does not rewind the window when a target back-dates an event', () => {
    const first = mergeTail(emptyTail(), [event('1', 100)]);
    const second = mergeTail(first, [event('2', 40)]);
    expect(second.nextStartTime).toBe(100);
  });
});

describe('tailStartTime', () => {
  it('looks back a fixed window for a tail that has seen nothing', () => {
    const now = 1_756_000_000_000;
    expect(tailStartTime(emptyTail(), now)).toBe(now - TAIL_LOOKBACK_MS);
  });

  it('starts at the newest event once there is one, however long the pause was', () => {
    const merged = mergeTail(emptyTail(), [event('1', 1_000)]);
    // A tail that was paused for an hour resumes where it left off rather than
    // skipping the hour, so nothing written meanwhile is lost.
    expect(tailStartTime(merged, 1_756_000_000_000)).toBe(1_000);
  });
});

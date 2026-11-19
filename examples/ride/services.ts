import { UnfoldError } from '@yodaos-pkg/unfold';
import type { Offer, RideReview } from './model.js';

const offers: Offer[] = [
  { id: 'offer_1', label: '特惠拼车', priceFen: 2400 },
  { id: 'offer_2', label: '经济型', priceFen: 3200 },
  { id: 'offer_3', label: '快车', priceFen: 3900 },
  { id: 'offer_4', label: '舒适型', priceFen: 4500 },
];

export async function getQuotes(
  _destination: string,
  { signal }: { signal: AbortSignal },
) {
  signal.throwIfAborted();
  return { offers, expiresAt: Date.now() + 120_000 };
}

export function readDestination(text: string) {
  return text
    .trim()
    .match(/(?:打车|叫车)(?:去|到)\s*(.+?)\s*[。！？!?]*$/u)?.[1];
}

export function readOfferOrdinal(text: string) {
  const value = text
    .trim()
    .match(
      /^(?:我选|就选|选)?第?([1-9]\d*|[一二三四])(?:个|项)?[。！!]?$/u,
    )?.[1];
  if (!value) return undefined;
  const numeral = '一二三四'.indexOf(value);
  return numeral >= 0 ? numeral + 1 : Number(value);
}

function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 125);
    function abort() {
      clearTimeout(timeout);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function* streamRideTips(
  destination: string,
  { prompt, signal }: { prompt?: string; signal: AbortSignal },
) {
  await pause(signal);
  yield `前往${destination}，请先确认上车地点。`;
  await pause(signal);
  yield prompt?.includes('行李')
    ? '携带行李时请预留后备箱空间。'
    : '出发前请留意路况和预计到达时间。';
}

export async function loadRidePreview(
  _user: string,
  rideId: string,
): Promise<RideReview> {
  if (rideId !== 'ride_123')
    throw new UnfoldError(404, 'ride_not_found', '行程不存在');
  return { destination: '西湖', offer: offers[3] };
}

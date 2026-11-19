import {
  end,
  stay,
  step,
  Task,
  TaskInputError,
  waitForInput,
  type TaskInputContext,
  type TaskStartContext,
} from '@yodaos-pkg/unfold';
import type { Offer, RideOptions, RideReview } from './model.js';
import { OrderReviewPage, RideOptionsPage } from './pages.js';
import { getQuotes, readDestination, readOfferOrdinal } from './services.js';

@Task()
export class RideTask {
  main() {
    return step('quote', this.loadQuotes).to(
      waitForInput('options', RideOptionsPage, this.chooseOffer)
        .on('selected', end('review', OrderReviewPage))
        .on('refreshed', stay()),
    );
  }

  async loadQuotes({ input, signal }: TaskStartContext): Promise<RideOptions> {
    let destination: string | undefined;
    if (input.type === 'text') {
      destination = readDestination(input.text);
    } else if (
      input.name === 'startRide' &&
      typeof input.data.destination === 'string'
    ) {
      destination = input.data.destination.trim();
    }
    if (!destination || destination.length > 120) {
      throw new TaskInputError('destination_required', '请告诉我你要去哪里');
    }
    return { destination, ...(await getQuotes(destination, { signal })) };
  }

  async chooseOffer({ state, input, signal }: TaskInputContext<RideOptions>) {
    let offer: Offer | undefined;
    if (input.type === 'text') {
      const ordinal = readOfferOrdinal(input.text);
      if (
        ordinal !== undefined &&
        Number.isSafeInteger(ordinal) &&
        ordinal >= 1
      ) {
        offer = state.offers[ordinal - 1];
      }
    } else if (input.name === 'selectOffer') {
      const { offerId } = input.data;
      offer = state.offers.find(({ id }) => id === offerId);
    }

    if (!offer)
      throw new TaskInputError('invalid_offer', '请选择列表中的一个报价');

    if (Date.now() >= state.expiresAt) {
      const quotes = await getQuotes(state.destination, { signal });
      const updated: RideOptions = {
        ...state,
        ...quotes,
        notice: '报价已更新，请重新选择',
      };
      return { outcome: 'refreshed', state: updated } as const;
    }
    const review: RideReview = { destination: state.destination, offer };
    return { outcome: 'selected', state: review } as const;
  }
}

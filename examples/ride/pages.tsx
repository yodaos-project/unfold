import {
  action,
  Button,
  defineInkRegion,
  InkPage,
  Text,
  View,
  type InkPageContext,
} from '@yodaos-pkg/unfold';
import type { RideOptions, RideReview } from './model.js';
import { streamRideTips } from './services.js';

const panel =
  'flex-direction: column; padding: 16px; background-color: #ffffff;';
const title = 'font-size: 24px; color: #17242a;';
const detail = 'font-size: 17px; color: #32464f;';

@InkPage()
export class RideOptionsPage {
  async *render({
    input: { destination, offers, notice },
    prompt,
    signal,
  }: InkPageContext<RideOptions>) {
    const Tips = defineInkRegion<string>('tips', {
      mode: 'append',
      component: ({ value }) => <Text style={detail}>{value}</Text>,
    });

    yield (
      <View style={panel}>
        <Text style={title}>去{destination}</Text>
        {notice && <Text style={detail}>{notice}</Text>}
        {offers.map((offer, index) => (
          <Button
            key={offer.id}
            onTap={action('selectOffer', { offerId: offer.id })}
          >
            {index + 1}. {offer.label} ¥{(offer.priceFen / 100).toFixed(2)}
          </Button>
        ))}
        <Tips />
      </View>
    );

    for await (const tip of streamRideTips(destination, { prompt, signal })) {
      yield Tips.append(tip);
    }
  }
}

@InkPage()
export class OrderReviewPage {
  async *render({ input }: InkPageContext<RideReview>) {
    yield (
      <View style={panel}>
        <Text style={title}>确认行程</Text>
        <Text style={detail}>目的地：{input.destination}</Text>
        <Text style={detail}>
          {input.offer.label} ¥{(input.offer.priceFen / 100).toFixed(2)}
        </Text>
      </View>
    );
  }
}

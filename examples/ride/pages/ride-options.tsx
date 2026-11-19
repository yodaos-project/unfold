import {
  action,
  Button,
  defineInkRegion,
  InkPage,
  Text,
  View,
  type InkPageContext,
} from '@yodaos-pkg/unfold';
import type { RideOptions } from '../model.js';
import { streamRideTips } from '../services.js';
import { panelStyle, titleStyle, detailStyle } from './styles.js';

@InkPage()
export class RideOptionsPage {
  async *render({
    input: { destination, offers, notice },
    prompt,
    signal,
  }: InkPageContext<RideOptions>) {
    const Tips = defineInkRegion<string>('tips', {
      mode: 'append',
      component: ({ value }) => <Text style={detailStyle}>{value}</Text>,
    });

    yield (
      <View style={panelStyle}>
        <Text style={titleStyle}>去{destination}</Text>
        {notice && <Text style={detailStyle}>{notice}</Text>}
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

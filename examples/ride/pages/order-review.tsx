import { InkPage, Text, View, type InkPageContext } from '@yodaos-pkg/unfold';
import type { RideReview } from '../model.js';
import { panelStyle, titleStyle, detailStyle } from './styles.js';

@InkPage()
export class OrderReviewPage {
  async *render({ input }: InkPageContext<RideReview>) {
    yield (
      <View style={panelStyle}>
        <Text style={titleStyle}>确认行程</Text>
        <Text style={detailStyle}>目的地：{input.destination}</Text>
        <Text style={detailStyle}>
          {input.offer.label} ¥{(input.offer.priceFen / 100).toFixed(2)}
        </Text>
      </View>
    );
  }
}

export interface Offer {
  id: string;
  label: string;
  priceFen: number;
}

export interface RideOptions {
  destination: string;
  offers: Offer[];
  expiresAt: number;
  notice?: string;
}

export interface RideReview {
  destination: string;
  offer: Offer;
}

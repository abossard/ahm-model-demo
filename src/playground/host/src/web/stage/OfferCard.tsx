import { acceptOffer, dismissOffer } from "../app/actions";
import { layerOf } from "../app/career";
import { useStore } from "../app/store";
import { ArrowIcon } from "../design/icons";

export function OfferCard() {
  const offer = useStore((state) => state.offer);
  if (!offer) return null;
  return (
    <aside className="offer" data-testid="offer" data-layer={offer.go ?? offer.layer} aria-label={offer.headline}>
      <div className="offer-copy">
        <p className="offer-did">{offer.did}</p>
        <p className="offer-next">{offer.next}</p>
      </div>
      <div className="offer-actions">
        {offer.go && (
          <button type="button" className="btn btn-primary" data-testid="offer-go" onClick={acceptOffer}>
            Go to {layerOf(offer.go).name} <ArrowIcon />
          </button>
        )}
        <button type="button" className="btn btn-quiet" data-testid="offer-stay" onClick={dismissOffer}>{offer.go ? "Stay here" : "Close"}</button>
      </div>
    </aside>
  );
}

import type { Seller } from "@/lib/catalog/types";
import { Avatar } from "./avatar";
import { StarIcon } from "./icons";

type Props = {
  seller: Seller;
  city?: boolean;
  rating?: { avg: number; count: number };
  className?: string;
};

export function SellerByline({ seller, city = true, rating, className }: Props) {
  return (
    <div className={["byline", className].filter(Boolean).join(" ")}>
      <Avatar src={seller.avatar} alt="" size="xs" />
      <span className="who">{seller.name}</span>
      {city ? <span className="loc">{seller.city}</span> : null}
      {rating ? (
        <span className="rating" title={`Rated ${rating.avg} by ${rating.count} buyers`}>
          <StarIcon />
          <b>{rating.avg.toFixed(1)}</b>
          <span>({rating.count})</span>
        </span>
      ) : null}
    </div>
  );
}

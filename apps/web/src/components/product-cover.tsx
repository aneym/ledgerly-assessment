import type { Product } from "@/lib/catalog/types";

type Props = {
  product: Pick<Product, "slug" | "title" | "cover" | "artworkKey">;
  /** 5:4 for the featured card and the product preview; 4:5 elsewhere. */
  wide?: boolean;
  /** Short mono tags read fine on a card. The product preview can carry longer ones. */
  detail?: boolean;
  className?: string;
};

/** Drawn covers, one per fixture slug. CSS gradients and inline SVG only, no image files. */
export function ProductCover({ product, wide, detail, className }: Props) {
  const key = product.artworkKey ?? product.slug;
  const art = ART[key] ?? DefaultArt;
  const cls = [
    "cover",
    `cv-${KEY[key] ?? "plain"}`,
    product.cover.tone === "light" ? "light" : "",
    wide ? "wide" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} role="img" aria-label={`${product.title} cover: ${product.cover.motif}`}>
      {art({ detail: Boolean(detail) })}
    </div>
  );
}

const KEY: Record<string, string> = {
  "grain-and-gradient": "grain",
  "kontur-type-specimen-kit": "kontur",
  "onda-drum-library": "onda",
  "ledger-layouts-for-framer": "ledger",
  "the-quiet-workbook": "quiet",
  "lowpoly-botanicals": "lowpoly",
  "notion-os-for-studios": "notion",
  "streetlight-sessions": "street",
};

type ArtProps = { detail: boolean };
type Art = (props: ArtProps) => React.ReactNode;

function DefaultArt() {
  return null;
}

const Grain: Art = ({ detail }) => (
  <>
    <span className="sp t" />
    <span className="sp b" />
    <span className="tag fr">{detail ? "24A · PORTRA 400" : "24A"}</span>
    <span className="tag nm">GG · 40 LOOKS</span>
  </>
);

const Kontur: Art = () => (
  <>
    <div className="spec">
      <b>Kontur Display</b>No. 04 · 12 faces
    </div>
    <div className="rule" />
    <div className="k">K</div>
    <div className="aa">Aa</div>
  </>
);

const RINGS: Array<[number, number, string?]> = [
  [16, 8],
  [34, 1.5],
  [50, 3, "22 9"],
  [66, 1],
  [84, 7, "60 16 26 16"],
  [104, 1.5],
  [122, 2.5, "10 7"],
  [142, 1],
  [162, 4, "110 36"],
  [184, 1],
  [206, 2, "5 5"],
  [232, 1],
  [256, 3, "80 30"],
  [280, 1],
  [306, 5, "140 60"],
];

const Onda: Art = ({ detail }) => (
  <>
    <svg viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="400" height="500" fill="#F0E8D5" />
      <g fill="none" stroke="#1B1916" transform="translate(200 250)">
        {RINGS.map(([r, w, dash]) => (
          <circle key={r} r={r} strokeWidth={w} strokeDasharray={dash} />
        ))}
      </g>
    </svg>
    <span className="tag">{detail ? "ONDA · 600 · 24-BIT · 48 KHZ" : "ONDA · 600 · 24-BIT"}</span>
  </>
);

const LAYERS = [
  { y: 0, l: "#152F8E", r: "#10246E", top: "#2749C2" },
  { y: -26, l: "#1A36A0", r: "#152F8E", top: "#3558D2" },
  { y: -52, l: "#2749C2", r: "#1A36A0", top: "#4A6BDD" },
  { y: -78, l: "#3558D2", r: "#2749C2", top: "#6D8AE7" },
  { y: -104, l: "#4A6BDD", r: "#3558D2", top: "#A3B5F0" },
];

const Ledger: Art = () => (
  <>
    <svg viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="400" height="500" fill="#1E3FB4" />
      <g transform="translate(200 300)">
        {LAYERS.map((s) => (
          <g key={s.y} transform={`translate(0 ${s.y})`}>
            <polygon points="-120,0 0,60 0,70 -120,10" fill={s.l} />
            <polygon points="0,60 120,0 120,10 0,70" fill={s.r} />
            <polygon
              points="0,-60 120,0 0,60 -120,0"
              fill={s.top}
              stroke="#1E3FB4"
              strokeWidth="2"
            />
          </g>
        ))}
        <g transform="translate(0 -130)">
          <polygon points="-120,0 0,60 0,70 -120,10" fill="#C7D1F3" />
          <polygon points="0,60 120,0 120,10 0,70" fill="#A3B5F0" />
          <polygon
            points="0,-60 120,0 0,60 -120,0"
            fill="#F3F0E9"
            stroke="#1E3FB4"
            strokeWidth="2"
          />
          <polygon points="-78,-8 -30,-32 -14,-24 -62,0" fill="#1E3FB4" opacity=".3" />
          <polygon points="-52,14 14,-19 30,-11 -36,22" fill="#1E3FB4" opacity=".18" />
          <polygon points="-26,34 40,1 56,9 -10,42" fill="#1E3FB4" opacity=".18" />
          <polygon points="26,-36 58,-52 74,-44 42,-28" fill="#1E3FB4" opacity=".65" />
        </g>
      </g>
    </svg>
    <span className="tag">18 TEMPLATES · FRAMER</span>
  </>
);

const Quiet: Art = () => (
  <>
    <div className="t">
      The Quiet
      <br />
      Workbook
    </div>
    <div className="rule" />
    <div className="s">Pricing your work, in 120 pages</div>
    <span className="tag">FORM STUDIO</span>
  </>
);

const LEAF: Array<[string, string]> = [
  ["200,300 150,250 200,240", "#2B6E47"],
  ["150,250 140,190 200,240", "#3B8A5A"],
  ["140,190 200,240 200,180", "#57A86E"],
  ["140,190 175,140 200,180", "#2B6E47"],
  ["175,140 200,110 200,180", "#8ACF8C"],
  ["200,300 250,250 200,240", "#23603D"],
  ["250,250 260,190 200,240", "#3B8A5A"],
  ["260,190 200,240 200,180", "#4E9C64"],
  ["260,190 225,140 200,180", "#2B6E47"],
  ["225,140 200,110 200,180", "#6FBE7B"],
  ["200,320 140,300 160,265", "#23603D"],
  ["140,300 95,255 160,265", "#3B8A5A"],
  ["160,265 95,255 120,210", "#2B6E47"],
  ["95,255 70,205 120,210", "#57A86E"],
  ["120,210 70,205 85,165", "#3B8A5A"],
  ["200,320 160,265 180,250", "#3B8A5A"],
  ["160,265 180,250 150,200", "#57A86E"],
  ["160,265 120,210 150,200", "#4E9C64"],
  ["120,210 150,200 115,170", "#8ACF8C"],
  ["120,210 115,170 85,165", "#57A86E"],
  ["200,320 260,300 240,265", "#2B6E47"],
  ["260,300 305,255 240,265", "#4E9C64"],
  ["240,265 305,255 280,210", "#23603D"],
  ["305,255 330,205 280,210", "#6FBE7B"],
  ["280,210 330,205 315,165", "#3B8A5A"],
  ["200,320 240,265 220,250", "#23603D"],
  ["240,265 220,250 250,200", "#3B8A5A"],
  ["240,265 280,210 250,200", "#57A86E"],
  ["280,210 250,200 285,170", "#4E9C64"],
  ["280,210 285,170 315,165", "#8ACF8C"],
];

const Lowpoly: Art = () => (
  <>
    <svg viewBox="0 0 400 500" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="400" height="500" fill="#0F2E20" />
      <g stroke="#0F2E20" strokeWidth="1.2" strokeLinejoin="round">
        <polygon points="196,470 204,470 203,300 197,300" fill="#1E4A33" stroke="none" />
        {LEAF.map(([points, fill]) => (
          <polygon key={points} points={points} fill={fill} />
        ))}
      </g>
    </svg>
    <span className="tag">80 MODELS · FBX · GLB</span>
  </>
);

const TILES = Array.from({ length: 20 }, (_, i) => i);

const Notion: Art = () => (
  <>
    {TILES.map((i) => (
      <i key={i} />
    ))}
  </>
);

const Street: Art = () => (
  <>
    <div className="halo" />
    <div className="ground" />
    <div className="pole" />
    <div className="head" />
    <div className="bulb" />
    <div className="noise" />
    <span className="tag">10 TRACKS · WAV + STEMS</span>
  </>
);

const ART: Record<string, Art> = {
  "grain-and-gradient": Grain,
  "kontur-type-specimen-kit": Kontur,
  "onda-drum-library": Onda,
  "ledger-layouts-for-framer": Ledger,
  "the-quiet-workbook": Quiet,
  "lowpoly-botanicals": Lowpoly,
  "notion-os-for-studios": Notion,
  "streetlight-sessions": Street,
};
